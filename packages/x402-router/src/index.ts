import {
  CDP_FORWARD_TOKEN_HEADER,
  defaultX402RouterUpstreams,
  ROUTER_PREFERENCE_HEADER,
  STANDARD_SCHEMES,
  type X402RouterUpstream,
  type X402SupportedKind,
  type X402SupportedResponse,
} from "./defaults";
import { parseRouterPreference, preferredNamesFor, type X402RouterPreference } from "./preference";
import { isRecord } from "./utils";

export type X402Endpoint = "verify" | "settle";

export type X402RouterOutboundFetch = (url: URL, init: RequestInit) => Promise<Response>;

export type X402RouterOptions = {
  cacheControl?: string;
  fetch?: X402RouterOutboundFetch;
  forwardedBearerHeader?: string;
  supported?: X402SupportedResponse;
  upstreams?: X402RouterUpstream[];
};

const SUPPORTED_X402_VERSION = 2;

/**
 * Fields in `extra` that tie a payment to one facilitator, such as the Solana fee payer the
 * buyer signed for. An upstream whose kind has a different value cannot settle the payment.
 */
const MATCH_FIELDS = [
  "feePayer",
  "facilitatorAddress",
  "receiverAuthorizer",
  "assetTransferMethod",
];

/** Upstream failure reasons that say "not here", so the next upstream can still take the payment. */
const TRY_NEXT_REASON =
  /unsupported|not_supported|not_managed|fee_payer_mismatch|free_tier|exhausted|unavailable|rate_limit|not_configured|unauthori[sz]ed/i;
const TRY_NEXT_STATUS = new Set([401, 403, 404, 408, 429]);
const TOP_UP_URL = /https:\/\/merchant\.payai\.network\/top-up[^\s"'\\]*/;

type X402FacilitatorPayload = Record<string, unknown>;
type SupportEntry = { supported: X402SupportedResponse; upstream: X402RouterUpstream };
type Attempt = { reason?: string; status: number; upstream: string };
type Outcome = "ok" | "next" | "stop";

function corsHeaders(init?: HeadersInit, allowedHeaders = "content-type, authorization") {
  const headers = new Headers(init);

  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", allowedHeaders);
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");

  return headers;
}

function json(value: unknown, init?: ResponseInit) {
  const headers = corsHeaders(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");

  return Response.json(value, { ...init, headers });
}

function empty(init?: ResponseInit, allowedHeaders?: string) {
  return new Response(null, { ...init, headers: corsHeaders(init?.headers, allowedHeaders) });
}

function facilitatorUrl(baseUrl: string, endpoint: X402Endpoint | "supported") {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${endpoint}`;

  return url;
}

function kindKey(kind: X402SupportedKind) {
  return `${kind.x402Version}:${kind.scheme}:${kind.network}`;
}

function preferredKind(current: X402SupportedKind | undefined, next: X402SupportedKind) {
  if (!current || (!current.extra && next.extra)) {
    return next;
  }

  return current;
}

function standardOnly(supported: X402SupportedResponse) {
  return {
    ...supported,
    kinds: supported.kinds.filter(
      (kind) =>
        kind.x402Version === SUPPORTED_X402_VERSION && STANDARD_SCHEMES.includes(kind.scheme),
    ),
  } satisfies X402SupportedResponse;
}

function staticSupportedFor(upstream: X402RouterUpstream) {
  return standardOnly({ kinds: upstream.supportedKinds ?? [] });
}

function tokenHeaderFor(upstream: X402RouterUpstream, options: X402RouterOptions) {
  const auth = upstream.auth ?? { type: "none" };

  if (auth.type !== "forwarded-bearer") {
    return null;
  }

  return auth.header ?? options.forwardedBearerHeader ?? CDP_FORWARD_TOKEN_HEADER;
}

function forwardedToken(
  request: Request,
  upstream: X402RouterUpstream,
  options: X402RouterOptions,
) {
  const header = tokenHeaderFor(upstream, options);

  return header ? request.headers.get(header) : null;
}

function needsToken(upstream: X402RouterUpstream) {
  return upstream.auth?.type === "forwarded-bearer" && upstream.auth.required !== false;
}

function usable(request: Request, upstream: X402RouterUpstream, options: X402RouterOptions) {
  return !needsToken(upstream) || Boolean(forwardedToken(request, upstream, options));
}

/**
 * The try order for one network. It starts from the seller's preference, then the configured
 * list. Upstreams with a key in this request go first. Upstreams that need a missing key drop out.
 */
function orderFor(
  request: Request,
  entries: SupportEntry[],
  network: string,
  preference: X402RouterPreference,
  options: X402RouterOptions,
) {
  const names = preferredNamesFor(preference, network);
  const rank = (entry: SupportEntry) => {
    const index = names.indexOf(entry.upstream.name);

    return index === -1 ? names.length : index;
  };
  const keyed = (entry: SupportEntry) => (forwardedToken(request, entry.upstream, options) ? 0 : 1);

  return entries
    .filter((entry) => usable(request, entry.upstream, options))
    .toSorted((a, b) => rank(a) - rank(b))
    .toSorted((a, b) => keyed(a) - keyed(b));
}

/** Each kind comes from the upstream that a payment for that kind would try first. */
function mergeSupported(
  request: Request,
  entries: SupportEntry[],
  preference: X402RouterPreference,
  options: X402RouterOptions,
) {
  const usableEntries = entries.filter((entry) => usable(request, entry.upstream, options));
  const byKey = new Map<string, Map<X402RouterUpstream, X402SupportedKind>>();
  const extensions = new Set<string>();
  const signers: Record<string, string[]> = {};

  for (const { supported, upstream } of usableEntries) {
    for (const kind of supported.kinds) {
      const owners = byKey.get(kindKey(kind)) ?? new Map<X402RouterUpstream, X402SupportedKind>();

      owners.set(upstream, preferredKind(owners.get(upstream), kind));
      byKey.set(kindKey(kind), owners);
    }

    for (const extension of supported.extensions ?? []) {
      extensions.add(extension);
    }

    for (const [network, values] of Object.entries(supported.signers ?? {})) {
      signers[network] = [...new Set([...(signers[network] ?? []), ...values])];
    }
  }

  const kinds = [...byKey.values()].flatMap((owners) => {
    const [first] = owners.values();
    const owner = orderFor(request, usableEntries, first.network, preference, options).find(
      (entry) => owners.has(entry.upstream),
    );

    return owner ? [owners.get(owner.upstream)!] : [];
  });

  return {
    ...(extensions.size > 0 ? { extensions: [...extensions].toSorted() } : {}),
    kinds,
    ...(Object.keys(signers).length > 0 ? { signers } : {}),
  } satisfies X402SupportedResponse;
}

function authHeadersFor(
  request: Request,
  upstream: X402RouterUpstream,
  endpoint: X402Endpoint | "supported",
  options: X402RouterOptions,
) {
  const headers = new Headers({ accept: "application/json" });
  const token = forwardedToken(request, upstream, options);

  if (token) {
    headers.set("authorization", token);
  }

  if (endpoint !== "supported") {
    headers.set("content-type", "application/json");
  }

  return headers;
}

function isSupportedResponse(value: unknown): value is X402SupportedResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.kinds) &&
    value.kinds.every(
      (kind) =>
        isRecord(kind) &&
        typeof kind.network === "string" &&
        typeof kind.scheme === "string" &&
        typeof kind.x402Version === "number" &&
        (kind.extra === undefined || isRecord(kind.extra)),
    ) &&
    (value.extensions === undefined ||
      (Array.isArray(value.extensions) &&
        value.extensions.every((extension) => typeof extension === "string"))) &&
    (value.signers === undefined ||
      (isRecord(value.signers) &&
        Object.values(value.signers).every(
          (signers) =>
            Array.isArray(signers) && signers.every((signer) => typeof signer === "string"),
        )))
  );
}

async function fetchSupportedForUpstream(
  request: Request,
  upstream: X402RouterUpstream,
  options: X402RouterOptions,
) {
  if (!usable(request, upstream, options)) {
    return staticSupportedFor(upstream);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const fetcher = options.fetch ?? globalThis.fetch;
    const response = await fetcher(facilitatorUrl(upstream.facilitatorUrl, "supported"), {
      headers: authHeadersFor(request, upstream, "supported", options),
      method: "GET",
      signal: controller.signal,
    });

    if (!response.ok) {
      return staticSupportedFor(upstream);
    }

    const supported: unknown = await response.json();

    return isSupportedResponse(supported) ? standardOnly(supported) : staticSupportedFor(upstream);
  } catch {
    return staticSupportedFor(upstream);
  } finally {
    clearTimeout(timeout);
  }
}

async function supportEntriesForRequest(
  request: Request,
  upstreams: X402RouterUpstream[],
  options: X402RouterOptions,
): Promise<SupportEntry[]> {
  if (options.supported) {
    return upstreams.map((upstream) => ({ supported: staticSupportedFor(upstream), upstream }));
  }

  return Promise.all(
    upstreams.map(async (upstream) => ({
      supported: await fetchSupportedForUpstream(request, upstream, options),
      upstream,
    })),
  );
}

async function parsePayload(request: Request): Promise<X402FacilitatorPayload | null> {
  try {
    const payload: unknown = await request.json();

    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function paymentRoute(payload: X402FacilitatorPayload) {
  const requirements = payload.paymentRequirements;

  if (!isRecord(requirements)) {
    return null;
  }

  const { network, scheme } = requirements;
  const version = requirements.x402Version ?? payload.x402Version;

  if (typeof network !== "string" || typeof scheme !== "string" || typeof version !== "number") {
    return null;
  }

  return {
    extra: isRecord(requirements.extra) ? requirements.extra : {},
    kind: { network, scheme, x402Version: version } satisfies X402SupportedKind,
  };
}

/** The upstreams that support this kind and can settle what the buyer signed, in try order. */
function candidatesFor(
  ordered: SupportEntry[],
  kind: X402SupportedKind,
  extra: Record<string, unknown>,
) {
  const key = kindKey(kind);

  return ordered
    .filter((entry) =>
      entry.supported.kinds.some(
        (supportedKind) =>
          kindKey(supportedKind) === key &&
          MATCH_FIELDS.every(
            (field) =>
              extra[field] === undefined ||
              supportedKind.extra?.[field] === undefined ||
              supportedKind.extra[field] === extra[field],
          ),
      ),
    )
    .map((entry) => entry.upstream);
}

function reasonOf(body: unknown) {
  if (!isRecord(body)) {
    return undefined;
  }

  const reason = [
    body.invalidCode,
    body.invalidReason,
    body.errorReason,
    body.error,
    body.code,
  ].find((value) => typeof value === "string");

  return typeof reason === "string" ? reason : undefined;
}

function outcomeOf(endpoint: X402Endpoint, status: number, body: unknown): Outcome {
  const accepted = isRecord(body) && (endpoint === "verify" ? body.isValid : body.success) === true;

  if (status >= 200 && status < 300 && accepted) {
    return "ok";
  }

  if (status >= 500 || TRY_NEXT_STATUS.has(status) || TRY_NEXT_REASON.test(reasonOf(body) ?? "")) {
    return "next";
  }

  return "stop";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The text a buyer can act on, or undefined to keep the upstream's own message. */
function buyerMessage(
  attempts: Attempt[],
  network: string,
  ambiguousSettle: boolean,
  lastOutcome: Outcome,
) {
  if (ambiguousSettle) {
    return {
      message: "The payment may have settled. Check your wallet before you pay again.",
      reason: "settlement_state_unknown",
    };
  }

  if (/allowance/i.test(attempts.at(-1)?.reason ?? "")) {
    return {
      message: `This payment needs a one-time Permit2 approval of the token on ${network} from your wallet. Approve it, or pay on another network.`,
    };
  }

  // A stop means the payment itself is invalid, so the upstream's own message is the right one.
  if (lastOutcome === "stop") {
    return undefined;
  }

  if (attempts.some((attempt) => /free_tier|exhausted/i.test(attempt.reason ?? ""))) {
    return {
      message:
        "The seller's payment provider is out of credits. Try again later, or pay on another network.",
    };
  }

  return { message: `No facilitator can settle this payment on ${network} right now.` };
}

function failureResponse(
  endpoint: X402Endpoint,
  network: string,
  attempts: Attempt[],
  last: { body: unknown; outcome: Outcome; status: number; text: string } | undefined,
  ambiguousSettle: boolean,
  topUpUrl: string | undefined,
) {
  const body = isRecord(last?.body) ? last.body : {};
  const hint = buyerMessage(attempts, network, ambiguousSettle, last?.outcome ?? "next");
  const reason = hint?.reason ?? reasonOf(body) ?? "no_facilitator_available";
  const extra = {
    ...(isRecord(body.extra) ? body.extra : {}),
    router: { tried: attempts, ...(topUpUrl ? { topUpUrl } : {}) },
  };
  const result =
    endpoint === "verify"
      ? {
          ...body,
          extra,
          invalidMessage: hint?.message ?? body.invalidMessage,
          invalidReason: reason,
          isValid: false,
        }
      : {
          ...body,
          errorMessage: hint?.message ?? body.errorMessage,
          errorReason: reason,
          extra,
          network: typeof body.network === "string" ? body.network : network,
          success: false,
          transaction: typeof body.transaction === "string" ? body.transaction : "",
        };
  const status = last?.outcome === "stop" ? last.status : 200;

  return json(result, { status });
}

/** Tries each candidate in order until one takes the payment or the payment itself is invalid. */
async function forwardToCandidates(
  request: Request,
  payload: X402FacilitatorPayload,
  candidates: X402RouterUpstream[],
  endpoint: X402Endpoint,
  network: string,
  options: X402RouterOptions,
) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const attempts: Attempt[] = [];
  let last: { body: unknown; outcome: Outcome; status: number; text: string } | undefined;
  let ambiguousSettle = false;
  let topUpUrl: string | undefined;

  for (const upstream of candidates) {
    let response: Response;
    let text: string;

    try {
      response = await fetcher(facilitatorUrl(upstream.facilitatorUrl, endpoint), {
        body: JSON.stringify(payload),
        headers: authHeadersFor(request, upstream, endpoint, options),
        method: "POST",
      });
      text = await response.text();
    } catch (error) {
      attempts.push({ reason: String(error), status: 0, upstream: upstream.name });
      ambiguousSettle ||= endpoint === "settle";
      last = { body: undefined, outcome: "next", status: 502, text: "" };
      continue;
    }

    topUpUrl ??= text.match(TOP_UP_URL)?.[0];
    const body = parseJson(text);
    const outcome = outcomeOf(endpoint, response.status, body);

    if (outcome === "ok") {
      const headers = corsHeaders();
      headers.set("content-type", response.headers.get("content-type") ?? "application/json");

      return new Response(text, { headers, status: response.status });
    }

    attempts.push({ reason: reasonOf(body), status: response.status, upstream: upstream.name });
    ambiguousSettle ||= endpoint === "settle" && response.status >= 500;
    last = { body, outcome, status: response.status, text };

    if (outcome === "stop") {
      break;
    }
  }

  return failureResponse(endpoint, network, attempts, last, ambiguousSettle, topUpUrl);
}

export function createX402Router(options: X402RouterOptions = {}) {
  const upstreams = options.upstreams ?? defaultX402RouterUpstreams;
  const tokenHeaders = upstreams.flatMap((upstream) => tokenHeaderFor(upstream, options) ?? []);
  const routingHeaders = [...new Set([...tokenHeaders, ROUTER_PREFERENCE_HEADER])];
  const corsAllowedHeaders = [
    ...new Set([
      "content-type",
      "authorization",
      ...routingHeaders.map((header) => header.toLowerCase()),
    ]),
  ].join(", ");

  return {
    async fetch(request: Request): Promise<Response> {
      const endpoint = new URL(request.url).pathname.replace(/^\/+|\/+$/g, "");
      const preference = parseRouterPreference(request.headers.get(ROUTER_PREFERENCE_HEADER));

      if (request.method === "OPTIONS") {
        return empty({ status: 204 }, corsAllowedHeaders);
      }

      if (request.method === "GET" && endpoint === "supported") {
        const sellerSpecific = routingHeaders.some((header) => request.headers.has(header));
        const supported = options.supported
          ? standardOnly(options.supported)
          : mergeSupported(
              request,
              await supportEntriesForRequest(request, upstreams, options),
              preference,
              options,
            );

        return json(supported, {
          headers: {
            "cache-control": sellerSpecific
              ? "private, max-age=300"
              : (options.cacheControl ?? "public, max-age=300"),
            vary: routingHeaders.join(", "),
          },
        });
      }

      if (request.method === "GET" && (endpoint === "health" || endpoint === "healthz")) {
        return json({ ok: true, service: "@tunnckocore/x402-router" });
      }

      if (request.method !== "POST" || (endpoint !== "verify" && endpoint !== "settle")) {
        return json({ error: "not_found" }, { status: 404 });
      }

      const payload = await parsePayload(request);

      if (!payload) {
        return json({ error: "invalid_json" }, { status: 400 });
      }

      const route = paymentRoute(payload);

      if (!route) {
        return json(
          {
            error: "invalid_x402_payload",
            message:
              "paymentRequirements.network, paymentRequirements.scheme, and x402Version are required",
          },
          { status: 400 },
        );
      }

      const entries = await supportEntriesForRequest(request, upstreams, options);
      const ordered = orderFor(request, entries, route.kind.network, preference, options);
      const candidates = candidatesFor(ordered, route.kind, route.extra);

      if (candidates.length > 0) {
        return forwardToCandidates(
          request,
          payload,
          candidates,
          endpoint,
          route.kind.network,
          options,
        );
      }

      const locked = candidatesFor(entries, route.kind, route.extra).find(needsToken);

      if (locked) {
        return json(
          {
            error: "missing_forwarded_bearer",
            message: `missing ${tokenHeaderFor(locked, options)} header for ${locked.name}`,
            upstream: locked.name,
          },
          { status: 401 },
        );
      }

      return json({ error: "unsupported_payment_requirements", ...route.kind }, { status: 400 });
    },
  };
}

const defaultRouter = createX402Router();

export const fetch = (request: Request) => defaultRouter.fetch(request);

export * from "./defaults";
export * from "./headers";
export * from "./preference";
