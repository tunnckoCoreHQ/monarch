import {
  CDP_FORWARD_TOKEN_HEADER,
  defaultX402RouterUpstreams,
  type X402RouterUpstream,
  type X402SupportedKind,
  type X402SupportedResponse,
} from "./defaults";

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

type PaymentRequirements = {
  network?: unknown;
  scheme?: unknown;
  x402Version?: unknown;
};

type X402FacilitatorPayload = {
  paymentRequirements?: PaymentRequirements;
  x402Version?: unknown;
};

function corsHeaders(
  init?: HeadersInit,
  allowedHeaders = "content-type, authorization, x-forwarded-cdp-token",
) {
  const headers = new Headers(init);

  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", allowedHeaders);
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");

  return headers;
}

function json(value: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  const finalHeaders = corsHeaders(headers);
  finalHeaders.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(value), { ...init, headers: finalHeaders });
}

function empty(init?: ResponseInit, allowedHeaders?: string) {
  const headers = corsHeaders(init?.headers, allowedHeaders);

  return new Response(null, { ...init, headers });
}

function facilitatorUrl(baseUrl: string, endpoint: X402Endpoint) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${endpoint}`;

  return url;
}

function kindKey(kind: X402SupportedKind) {
  return `${kind.x402Version}:${kind.scheme}:${kind.network}`;
}

function preferredKind(current: X402SupportedKind | undefined, next: X402SupportedKind) {
  if (!current) {
    return next;
  }

  if (!current.extra && next.extra) {
    return next;
  }

  return current;
}

function supportedV2Only(supported: X402SupportedResponse) {
  return {
    ...supported,
    kinds: supported.kinds.filter((kind) => kind.x402Version === SUPPORTED_X402_VERSION),
  } satisfies X402SupportedResponse;
}

function staticSupportedFor(upstream: X402RouterUpstream) {
  return supportedV2Only({ kinds: upstream.supportedKinds ?? [] });
}

function forwardedBearerToken(
  request: Request,
  upstream: X402RouterUpstream,
  options: X402RouterOptions,
) {
  const auth = upstream.auth ?? { type: "none" };

  if (auth.type !== "forwarded-bearer") {
    return null;
  }

  const header = auth.header ?? options.forwardedBearerHeader ?? CDP_FORWARD_TOKEN_HEADER;

  return request.headers.get(header);
}

function mergeSupported(responses: X402SupportedResponse[]) {
  const extensions = new Set<string>();
  const kinds = new Map<string, X402SupportedKind>();
  const signers: Record<string, string[]> = {};

  for (const response of responses.map((supported) => supportedV2Only(supported))) {
    for (const kind of response.kinds) {
      const key = kindKey(kind);

      kinds.set(key, preferredKind(kinds.get(key), kind));
    }

    for (const extension of response.extensions ?? []) {
      extensions.add(extension);
    }

    for (const [network, values] of Object.entries(response.signers ?? {})) {
      signers[network] = [...new Set([...(signers[network] ?? []), ...values])];
    }
  }

  return {
    ...(extensions.size > 0 ? { extensions: [...extensions].sort() } : {}),
    kinds: [...kinds.values()],
    ...(Object.keys(signers).length > 0 ? { signers } : {}),
  } satisfies X402SupportedResponse;
}

async function authHeadersFor(
  request: Request,
  upstream: X402RouterUpstream,
  endpoint: X402Endpoint | "supported",
  options: X402RouterOptions,
) {
  const headers = new Headers({ accept: "application/json" });
  const auth = upstream.auth ?? { type: "none" };

  if (auth.type === "forwarded-bearer") {
    const token = forwardedBearerToken(request, upstream, options);

    if (!token) {
      return null;
    }

    headers.set("authorization", token);
  }

  if (endpoint !== "supported") {
    headers.set("content-type", "application/json");
  }

  return headers;
}

async function fetchSupportedForUpstream(
  request: Request,
  upstream: X402RouterUpstream,
  options: X402RouterOptions,
) {
  const headers = await authHeadersFor(request, upstream, "supported", options);

  if (!headers) {
    return staticSupportedFor(upstream);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const fetcher = options.fetch ?? globalThis.fetch;
    const url = new URL(upstream.facilitatorUrl);

    url.pathname = `${url.pathname.replace(/\/$/, "")}/supported`;

    const response = await fetcher(url, {
      headers,
      method: "GET",
      signal: controller.signal,
    });

    if (!response.ok) {
      return staticSupportedFor(upstream);
    }

    const supported = (await response.json()) as X402SupportedResponse;

    if (!Array.isArray(supported.kinds)) {
      return staticSupportedFor(upstream);
    }

    return supportedV2Only(supported);
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
) {
  if (options.supported) {
    return upstreams.map((upstream) => ({
      supported: staticSupportedFor(upstream),
      upstream,
    }));
  }

  return Promise.all(
    upstreams.map(async (upstream) => ({
      supported: await fetchSupportedForUpstream(request, upstream, options),
      upstream,
    })),
  );
}

async function supportedForRequest(
  request: Request,
  upstreams: X402RouterUpstream[],
  options: X402RouterOptions,
) {
  if (options.supported) {
    return supportedV2Only(options.supported);
  }

  return mergeSupported(
    (await supportEntriesForRequest(request, upstreams, options)).map((entry) => entry.supported),
  );
}

function routeFor(
  request: Request,
  entries: { supported: X402SupportedResponse; upstream: X402RouterUpstream }[],
  kind: X402SupportedKind,
  options: X402RouterOptions,
): X402RouterUpstream | undefined {
  const targetKey = kindKey(kind);
  const matches = entries.filter((entry) =>
    entry.supported.kinds.some((supportedKind) => kindKey(supportedKind) === targetKey),
  );

  return (
    matches.find((entry) => forwardedBearerToken(request, entry.upstream, options))?.upstream ??
    matches[0]?.upstream
  );
}

async function parsePayload(request: Request): Promise<X402FacilitatorPayload | null> {
  try {
    const payload = (await request.json()) as unknown;

    if (payload && typeof payload === "object") {
      return payload as X402FacilitatorPayload;
    }
  } catch {
    return null;
  }

  return null;
}

function paymentRoute(payload: X402FacilitatorPayload) {
  const requirements = payload.paymentRequirements;
  const network = requirements?.network;
  const scheme = requirements?.scheme;
  const version = requirements?.x402Version ?? payload.x402Version;

  if (typeof network !== "string" || typeof scheme !== "string" || typeof version !== "number") {
    return null;
  }

  return { network, scheme, x402Version: version } satisfies X402SupportedKind;
}

async function forwardToUpstream(
  request: Request,
  payload: X402FacilitatorPayload,
  upstream: X402RouterUpstream,
  endpoint: X402Endpoint,
  options: X402RouterOptions,
) {
  const headers = await authHeadersFor(request, upstream, endpoint, options);

  if (!headers) {
    const auth = upstream.auth ?? { type: "none" };
    const header =
      auth.type === "forwarded-bearer"
        ? (auth.header ?? options.forwardedBearerHeader ?? CDP_FORWARD_TOKEN_HEADER)
        : "authorization";

    return json(
      {
        error: "missing_forwarded_bearer",
        message: `missing ${header} header for ${upstream.name}`,
        upstream: upstream.name,
      },
      { status: 401 },
    );
  }

  const fetcher = options.fetch ?? globalThis.fetch;
  const response = await fetcher(facilitatorUrl(upstream.facilitatorUrl, endpoint), {
    body: JSON.stringify(payload),
    headers,
    method: "POST",
  });
  const responseHeaders = new Headers();
  const contentType = response.headers.get("content-type");

  responseHeaders.set("access-control-allow-origin", "*");

  if (contentType) {
    responseHeaders.set("content-type", contentType);
  }

  return new Response(response.body, {
    headers: responseHeaders,
    status: response.status,
    statusText: response.statusText,
  });
}

export function createX402Router(options: X402RouterOptions = {}) {
  const upstreams = options.upstreams ?? defaultX402RouterUpstreams;
  const allowedHeaders = ["content-type", "authorization"];

  for (const upstream of upstreams) {
    if (upstream.auth?.type === "forwarded-bearer") {
      allowedHeaders.push(
        (
          upstream.auth.header ??
          options.forwardedBearerHeader ??
          CDP_FORWARD_TOKEN_HEADER
        ).toLowerCase(),
      );
    }
  }

  const corsAllowedHeaders = [...new Set(allowedHeaders)].join(", ");

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const endpoint = url.pathname.replace(/^\/+|\/+$/g, "");

      if (request.method === "OPTIONS") {
        return empty({ status: 204 }, corsAllowedHeaders);
      }

      if (request.method === "GET" && endpoint === "supported") {
        return json(await supportedForRequest(request, upstreams, options), {
          headers: {
            "cache-control": options.cacheControl ?? "public, max-age=300",
          },
        });
      }

      if (request.method === "GET" && (endpoint === "health" || endpoint === "healthz")) {
        return json({
          ok: true,
          service: "@tunnckocore/x402-router",
        });
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

      const supportEntries = await supportEntriesForRequest(request, upstreams, options);
      const upstream = routeFor(request, supportEntries, route, options);

      if (!upstream) {
        return json(
          {
            error: "unsupported_payment_requirements",
            network: route.network,
            scheme: route.scheme,
            x402Version: route.x402Version,
          },
          { status: 400 },
        );
      }

      return forwardToUpstream(request, payload, upstream, endpoint, options);
    },
  };
}

const defaultRouter = createX402Router();

export const fetch = (request: Request) => defaultRouter.fetch(request);

export * from "./defaults";
