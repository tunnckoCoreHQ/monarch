import { expect, test, vi } from "vitest";

import { CDP_FACILITATOR_URL, cdpRequestTarget, createCdpAuthHeaders } from "../src/cdp";
import {
  BASE_MAINNET,
  BASE_SEPOLIA,
  CDP_FORWARD_TOKEN_HEADER,
  createRouterAuthHeaders,
  createX402Router,
  DEXTER_FACILITATOR_URL,
  ETHEREUM_MAINNET,
  PAYAI_FACILITATOR_URL,
  PAYAI_FORWARD_TOKEN_HEADER,
  parseRouterPreference,
  PRIMEV_FACILITATOR_URL,
  ROUTER_PREFERENCE_HEADER,
  routerPreferenceHeaders,
  SOLANA_MAINNET,
  WORLD_CHAIN_SEPOLIA,
  type X402RouterPreference,
  type X402SupportedKind,
  X402_ORG_FACILITATOR_URL,
} from "../src/index";
import { createPayAIAuthHeaders } from "../src/payai";

type Verdict = { body: Record<string, unknown>; status?: number } | Error;

const exact = (network: string, extra?: Record<string, unknown>): X402SupportedKind => ({
  ...(extra ? { extra } : {}),
  network,
  scheme: "exact",
  x402Version: 2,
});

const ACCEPT: Verdict = {
  body: { isValid: true, payer: "buyer", success: true, transaction: "0xtx" },
};

/** Fake live facilitators keyed by base URL. Each one answers `/supported` and its verdict. */
function facilitators(
  kinds: Record<string, X402SupportedKind[]>,
  verdicts: Record<string, Verdict> = {},
) {
  const calls: Array<{ authorization: string | null; url: string }> = [];
  const fetch = async (url: URL, init: RequestInit) => {
    calls.push({ authorization: new Headers(init.headers).get("authorization"), url: url.href });
    const base = url.href.replace(/\/(supported|verify|settle)$/, "");

    if (url.pathname.endsWith("/supported")) {
      return Response.json({ kinds: kinds[base] ?? [] });
    }

    const verdict = verdicts[base] ?? ACCEPT;

    if (verdict instanceof Error) {
      throw verdict;
    }

    return Response.json({ ...verdict.body, by: base }, { status: verdict.status ?? 200 });
  };
  const forwarded = () =>
    calls
      .filter((call) => !call.url.endsWith("/supported"))
      .map((call) => call.url.replace(/\/(verify|settle)$/, ""));

  return { calls, fetch, forwarded };
}

function paymentRequest(
  network: string,
  options: {
    endpoint?: "verify" | "settle";
    extra?: Record<string, unknown>;
    headers?: Record<string, string>;
    scheme?: string;
  } = {},
) {
  return new Request(`https://router.example/${options.endpoint ?? "verify"}`, {
    body: JSON.stringify({
      paymentPayload: {},
      paymentRequirements: { extra: options.extra, network, scheme: options.scheme ?? "exact" },
      x402Version: 2,
    }),
    headers: options.headers,
    method: "POST",
  });
}

const CDP_TOKEN = { [CDP_FORWARD_TOKEN_HEADER]: "Bearer cdp" };
const PAYAI_KEY = { [PAYAI_FORWARD_TOKEN_HEADER]: "Bearer payai" };
const prefer = (preference: X402RouterPreference) => routerPreferenceHeaders(preference);

const baseEverywhere = {
  [CDP_FACILITATOR_URL]: [exact(BASE_MAINNET)],
  [DEXTER_FACILITATOR_URL]: [exact(BASE_MAINNET)],
  [PAYAI_FACILITATOR_URL]: [exact(BASE_MAINNET)],
};

async function bodyOf(response: Response) {
  return response.json<Record<string, unknown> & { kinds: X402SupportedKind[] }>();
}

test("serves the live merged supported response with cache headers", async () => {
  const router = createX402Router({
    fetch: async (url) => {
      if (url.href === `${PRIMEV_FACILITATOR_URL}/supported`) {
        return Response.json({
          extensions: ["primev"],
          kinds: [{ network: ETHEREUM_MAINNET, scheme: "exact", x402Version: 2 }],
          signers: { "eip155:*": ["0xprimev"] },
        });
      }

      return Response.json({
        extensions: ["x402-org"],
        kinds: [
          { network: BASE_SEPOLIA, scheme: "exact", x402Version: 1 },
          { network: BASE_SEPOLIA, scheme: "exact", x402Version: 2 },
          { network: BASE_SEPOLIA, scheme: "upto", x402Version: 2 },
          {
            extra: { feePayer: "0xtestnet" },
            network: BASE_SEPOLIA,
            scheme: "exact",
            x402Version: 2,
          },
        ],
        signers: { "eip155:*": ["0xtestnet"] },
      });
    },
    upstreams: [
      {
        facilitatorUrl: PRIMEV_FACILITATOR_URL,
        name: "primev",
        supportedKinds: [{ network: ETHEREUM_MAINNET, scheme: "exact", x402Version: 2 }],
      },
      {
        facilitatorUrl: "https://x402.org/facilitator",
        name: "x402-testnet",
        supportedKinds: [{ network: BASE_SEPOLIA, scheme: "exact", x402Version: 2 }],
      },
    ],
  });
  const response = await router.fetch(new Request("https://router.example/supported"));
  const body = await response.json<{ kinds: unknown[] }>();

  expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  expect(body.kinds).toContainEqual({ network: ETHEREUM_MAINNET, scheme: "exact", x402Version: 2 });
  expect(body.kinds).not.toContainEqual({ network: BASE_SEPOLIA, scheme: "exact", x402Version: 1 });
  expect(body.kinds).toContainEqual({
    extra: { feePayer: "0xtestnet" },
    network: BASE_SEPOLIA,
    scheme: "exact",
    x402Version: 2,
  });
  expect(body.kinds).toContainEqual({ network: BASE_SEPOLIA, scheme: "upto", x402Version: 2 });
});

test.each([
  null,
  { kinds: [null] },
  { kinds: [{ network: 1, scheme: "exact", x402Version: 2 }] },
  { kinds: [], extensions: [1] },
  { kinds: [], signers: { "eip155:*": [1] } },
])("falls back to static support for malformed discovery metadata %j", async (metadata) => {
  const kind = { network: ETHEREUM_MAINNET, scheme: "exact", x402Version: 2 };
  const router = createX402Router({
    fetch: async () => Response.json(metadata),
    upstreams: [{ facilitatorUrl: PRIMEV_FACILITATOR_URL, name: "primev", supportedKinds: [kind] }],
  });
  const response = await router.fetch(new Request("https://router.example/supported"));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ kinds: [kind] });
});

test("falls back to static upstream support when supported fetch fails", async () => {
  const router = createX402Router({
    cacheControl: "public, max-age=3600",
    fetch: async () => new Response("broken", { status: 503 }),
    upstreams: [
      {
        facilitatorUrl: PRIMEV_FACILITATOR_URL,
        name: "primev",
        supportedKinds: [{ network: ETHEREUM_MAINNET, scheme: "exact", x402Version: 2 }],
      },
    ],
  });
  const response = await router.fetch(new Request("https://router.example/supported"));
  const body = await response.json<{ kinds: unknown[] }>();

  expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  expect(body.kinds).toEqual([{ network: ETHEREUM_MAINNET, scheme: "exact", x402Version: 2 }]);
});

test("serves health checks", async () => {
  const router = createX402Router();

  await expect(
    router.fetch(new Request("https://router.example/health")).then((res) => res.json()),
  ).resolves.toEqual({
    ok: true,
    service: "@tunnckocore/x402-router",
  });
  await expect(
    router.fetch(new Request("https://router.example/healthz")).then((res) => res.json()),
  ).resolves.toMatchObject({ ok: true });
});

test.each([
  ["no keys", {}, PAYAI_FACILITATOR_URL],
  ["a CDP token", CDP_TOKEN, CDP_FACILITATOR_URL],
  ["a PayAI key", PAYAI_KEY, PAYAI_FACILITATOR_URL],
  ["both keys", { ...CDP_TOKEN, ...PAYAI_KEY }, CDP_FACILITATOR_URL],
  [
    "both keys and PayAI preferred",
    { ...CDP_TOKEN, ...PAYAI_KEY, ...prefer({ eip155: ["payai", "cdp", "dexter"] }) },
    PAYAI_FACILITATOR_URL,
  ],
  [
    "a CDP token and PayAI preferred",
    { ...CDP_TOKEN, ...prefer({ eip155: ["payai", "cdp", "dexter"] }) },
    CDP_FACILITATOR_URL,
  ],
  ["Dexter preferred and no keys", prefer({ eip155: ["dexter"] }), DEXTER_FACILITATOR_URL],
  [
    "a network preference over the family",
    prefer({ eip155: ["payai"], [BASE_MAINNET]: ["dexter"] }),
    DEXTER_FACILITATOR_URL,
  ],
])("routes a Base payment with %s", async (_name, headers, expected) => {
  const { fetch, forwarded } = facilitators(baseEverywhere);
  const router = createX402Router({ fetch });
  const response = await router.fetch(paymentRequest(BASE_MAINNET, { headers }));

  expect(response.status).toBe(200);
  expect(forwarded()).toEqual([expected]);
});

test("forwards each key only to its own upstream", async () => {
  const { calls, fetch } = facilitators(baseEverywhere);
  const router = createX402Router({ fetch });

  await router.fetch(paymentRequest(BASE_MAINNET, { headers: { ...CDP_TOKEN, ...PAYAI_KEY } }));

  expect(calls.find((call) => call.url === `${CDP_FACILITATOR_URL}/verify`)?.authorization).toBe(
    "Bearer cdp",
  );
  expect(
    calls.find((call) => call.url === `${PAYAI_FACILITATOR_URL}/supported`)?.authorization,
  ).toBe("Bearer payai");
  expect(
    calls.find((call) => call.url === `${DEXTER_FACILITATOR_URL}/supported`)?.authorization,
  ).toBe(null);
});

test("routes Ethereum Mainnet to PrimeV", async () => {
  const { fetch, forwarded } = facilitators({
    [PRIMEV_FACILITATOR_URL]: [exact(ETHEREUM_MAINNET)],
  });
  const router = createX402Router({ fetch });

  expect((await router.fetch(paymentRequest(ETHEREUM_MAINNET))).status).toBe(200);
  expect(forwarded()).toEqual([PRIMEV_FACILITATOR_URL]);
});

const solanaFeePayers = {
  [CDP_FACILITATOR_URL]: [exact(SOLANA_MAINNET, { feePayer: "cdp-payer" })],
  [DEXTER_FACILITATOR_URL]: [exact(SOLANA_MAINNET, { feePayer: "dexter-payer" })],
  [PAYAI_FACILITATOR_URL]: [exact(SOLANA_MAINNET, { feePayer: "payai-payer" })],
};

test.each([
  ["no keys", {}, "payai-payer"],
  ["a CDP token", CDP_TOKEN, "cdp-payer"],
  ["Dexter preferred", prefer({ solana: ["dexter"] }), "dexter-payer"],
])("serves the Solana fee payer of the first upstream for %s", async (_name, headers, feePayer) => {
  const { fetch } = facilitators(solanaFeePayers);
  const router = createX402Router({ fetch });
  const response = await router.fetch(new Request("https://router.example/supported", { headers }));
  const body = await bodyOf(response);

  expect(body.kinds).toEqual([exact(SOLANA_MAINNET, { feePayer })]);
});

test("keeps seller-specific supported responses out of shared caches", async () => {
  const { fetch } = facilitators(solanaFeePayers);
  const router = createX402Router({ fetch });
  const shared = await router.fetch(new Request("https://router.example/supported"));
  const seller = await router.fetch(
    new Request("https://router.example/supported", { headers: CDP_TOKEN }),
  );

  expect(shared.headers.get("cache-control")).toBe("public, max-age=300");
  expect(seller.headers.get("cache-control")).toBe("private, max-age=300");
  expect(seller.headers.get("vary")).toContain(CDP_FORWARD_TOKEN_HEADER);
  expect(seller.headers.get("vary")).toContain(ROUTER_PREFERENCE_HEADER);
});

test.each([
  ["cdp-payer", CDP_TOKEN, CDP_FACILITATOR_URL],
  ["dexter-payer", {}, DEXTER_FACILITATOR_URL],
  ["payai-payer", CDP_TOKEN, PAYAI_FACILITATOR_URL],
])(
  "routes a Solana payment that names %s to that facilitator",
  async (feePayer, headers, expected) => {
    const { fetch, forwarded } = facilitators(solanaFeePayers);
    const router = createX402Router({ fetch });

    await router.fetch(paymentRequest(SOLANA_MAINNET, { extra: { feePayer }, headers }));

    expect(forwarded()).toEqual([expected]);
  },
);

test("lists only standard schemes", async () => {
  const { fetch } = facilitators({
    [DEXTER_FACILITATOR_URL]: [
      exact(SOLANA_MAINNET),
      { network: SOLANA_MAINNET, scheme: "tab", x402Version: 2 },
      { network: BASE_MAINNET, scheme: "bridge", x402Version: 2 },
      { network: BASE_MAINNET, scheme: "upto", x402Version: 2 },
      { network: BASE_MAINNET, scheme: "batch-settlement", x402Version: 2 },
    ],
  });
  const router = createX402Router({ fetch });
  const body = await bodyOf(await router.fetch(new Request("https://router.example/supported")));

  expect(body.kinds.map((kind) => kind.scheme)).toEqual(["exact", "upto", "batch-settlement"]);
});

test("tries the next upstream when PayAI is out of credits", async () => {
  const { fetch, forwarded } = facilitators(baseEverywhere, {
    [PAYAI_FACILITATOR_URL]: { body: { error: "free_tier_exhausted" }, status: 403 },
  });
  const router = createX402Router({ fetch });
  const response = await router.fetch(paymentRequest(BASE_MAINNET, { endpoint: "settle" }));

  expect(await bodyOf(response)).toMatchObject({ by: DEXTER_FACILITATOR_URL, success: true });
  expect(forwarded()).toEqual([PAYAI_FACILITATOR_URL, DEXTER_FACILITATOR_URL]);
});

test.each([
  ["a 5xx", { body: { isValid: false }, status: 503 }],
  [
    "an unsupported payload",
    { body: { invalidReason: "invalid_exact_evm_eip3009_not_supported", isValid: false } },
  ],
  ["a network error", new Error("connect ECONNREFUSED")],
])("tries the next upstream on %s during verify", async (_name, verdict) => {
  const { fetch, forwarded } = facilitators(baseEverywhere, { [PAYAI_FACILITATOR_URL]: verdict });
  const router = createX402Router({ fetch });
  const response = await router.fetch(paymentRequest(BASE_MAINNET));

  expect(await bodyOf(response)).toMatchObject({ by: DEXTER_FACILITATOR_URL, isValid: true });
  expect(forwarded()).toEqual([PAYAI_FACILITATOR_URL, DEXTER_FACILITATOR_URL]);
});

test("stops at an invalid payment and keeps the upstream answer", async () => {
  const { fetch, forwarded } = facilitators(baseEverywhere, {
    [PAYAI_FACILITATOR_URL]: {
      body: {
        invalidMessage: "bad signature",
        invalidReason: "invalid_exact_evm_signature",
        isValid: false,
      },
    },
  });
  const router = createX402Router({ fetch });
  const response = await router.fetch(paymentRequest(BASE_MAINNET));

  expect(response.status).toBe(200);
  expect(await bodyOf(response)).toMatchObject({
    extra: { router: { tried: [{ reason: "invalid_exact_evm_signature", upstream: "payai" }] } },
    invalidMessage: "bad signature",
    invalidReason: "invalid_exact_evm_signature",
    isValid: false,
  });
  expect(forwarded()).toEqual([PAYAI_FACILITATOR_URL]);
});

test("tells the buyer when the only path is out of credits", async () => {
  const topUpUrl = "https://merchant.payai.network/top-up?payTo=seller";
  const { fetch } = facilitators(solanaFeePayers, {
    [PAYAI_FACILITATOR_URL]: {
      body: { error: "free_tier_exhausted", message: `Top up at ${topUpUrl}` },
      status: 403,
    },
  });
  const router = createX402Router({ fetch });
  const response = await router.fetch(
    paymentRequest(SOLANA_MAINNET, { endpoint: "settle", extra: { feePayer: "payai-payer" } }),
  );

  expect(await bodyOf(response)).toMatchObject({
    errorMessage:
      "The seller's payment provider is out of credits. Try again later, or pay on another network.",
    errorReason: "free_tier_exhausted",
    extra: { router: { topUpUrl, tried: [{ status: 403, upstream: "payai" }] } },
    network: SOLANA_MAINNET,
    success: false,
    transaction: "",
  });
});

test("tells the buyer about a missing Permit2 allowance", async () => {
  const { fetch } = facilitators(
    { [DEXTER_FACILITATOR_URL]: [exact(BASE_MAINNET, { assetTransferMethod: "permit2" })] },
    {
      [DEXTER_FACILITATOR_URL]: {
        body: { invalidReason: "permit2_allowance_required", isValid: false },
      },
    },
  );
  const router = createX402Router({ fetch });
  const response = await router.fetch(
    paymentRequest(BASE_MAINNET, { extra: { assetTransferMethod: "permit2" } }),
  );

  expect(await bodyOf(response)).toMatchObject({
    invalidMessage: `This payment needs a one-time Permit2 approval of the token on ${BASE_MAINNET} from your wallet. Approve it, or pay on another network.`,
    invalidReason: "permit2_allowance_required",
  });
});

test("says the settlement state is unknown after a settle that failed midway", async () => {
  const { fetch, forwarded } = facilitators(baseEverywhere, {
    [DEXTER_FACILITATOR_URL]: {
      body: { errorReason: "invalid_exact_evm_nonce_already_used", success: false },
    },
    [PAYAI_FACILITATOR_URL]: { body: { success: false }, status: 504 },
  });
  const router = createX402Router({ fetch });
  const response = await router.fetch(paymentRequest(BASE_MAINNET, { endpoint: "settle" }));

  expect(forwarded()).toEqual([PAYAI_FACILITATOR_URL, DEXTER_FACILITATOR_URL]);
  expect(response.status).toBe(200);
  expect(await bodyOf(response)).toMatchObject({
    errorMessage: "The payment may have settled. Check your wallet before you pay again.",
    errorReason: "settlement_state_unknown",
    success: false,
  });
});

test("says no facilitator can settle when every upstream is down", async () => {
  const down: Verdict = { body: {}, status: 502 };
  const { fetch } = facilitators(baseEverywhere, {
    [DEXTER_FACILITATOR_URL]: down,
    [PAYAI_FACILITATOR_URL]: down,
  });
  const router = createX402Router({ fetch });

  expect(await bodyOf(await router.fetch(paymentRequest(BASE_MAINNET)))).toMatchObject({
    invalidMessage: `No facilitator can settle this payment on ${BASE_MAINNET} right now.`,
    invalidReason: "no_facilitator_available",
    isValid: false,
  });
});

test("asks for the CDP token when only CDP supports the payment", async () => {
  const { fetch, forwarded } = facilitators({});
  const router = createX402Router({ fetch });
  const response = await router.fetch(paymentRequest(WORLD_CHAIN_SEPOLIA));

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({
    error: "missing_forwarded_bearer",
    message: `missing ${CDP_FORWARD_TOKEN_HEADER} header for cdp`,
  });
  expect(forwarded()).toEqual([]);
});

test("rejects a payment that no upstream supports", async () => {
  const { fetch } = facilitators({});
  const router = createX402Router({ fetch, upstreams: [] });
  const response = await router.fetch(paymentRequest(BASE_SEPOLIA, { scheme: "upto" }));

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    error: "unsupported_payment_requirements",
  });
});

test("allows the routing headers in CORS preflight", async () => {
  const router = createX402Router();
  const preflight = await router.fetch(
    new Request("https://router.example/verify", { method: "OPTIONS" }),
  );
  const allowed = preflight.headers.get("access-control-allow-headers");

  expect(allowed).toContain(CDP_FORWARD_TOKEN_HEADER.toLowerCase());
  expect(allowed).toContain(PAYAI_FORWARD_TOKEN_HEADER.toLowerCase());
  expect(allowed).toContain(ROUTER_PREFERENCE_HEADER.toLowerCase());
});

test("uses a custom token header for default CDP routing", async () => {
  const { calls, fetch } = facilitators({ [CDP_FACILITATOR_URL]: [exact(WORLD_CHAIN_SEPOLIA)] });
  const router = createX402Router({ fetch, forwardedBearerHeader: "X-Seller-Token" });
  const missing = await router.fetch(paymentRequest(WORLD_CHAIN_SEPOLIA));

  await expect(missing.json()).resolves.toMatchObject({
    message: "missing X-Seller-Token header for cdp",
  });

  const response = await router.fetch(
    paymentRequest(WORLD_CHAIN_SEPOLIA, { headers: { "X-Seller-Token": "Bearer custom" } }),
  );

  expect(response.status).toBe(200);
  expect(calls.at(-1)).toEqual({
    authorization: "Bearer custom",
    url: `${CDP_FACILITATOR_URL}/verify`,
  });
});

function upto(facilitatorAddress: string): X402SupportedKind {
  return { extra: { facilitatorAddress }, network: BASE_SEPOLIA, scheme: "upto", x402Version: 2 };
}

test("routes upto payments to the facilitator address the buyer signed for", async () => {
  const { fetch, forwarded } = facilitators({
    [DEXTER_FACILITATOR_URL]: [upto("0xdexter")],
    [X402_ORG_FACILITATOR_URL]: [upto("0xx402")],
  });
  const router = createX402Router({ fetch });

  await router.fetch(
    paymentRequest(BASE_SEPOLIA, { extra: { facilitatorAddress: "0xx402" }, scheme: "upto" }),
  );

  expect(forwarded()).toEqual([X402_ORG_FACILITATOR_URL]);
});

test.each(["supported", "verify", "settle"])(
  "bounds stalled discovery before serving %s",
  async (endpoint) => {
    vi.useFakeTimers();
    try {
      let discoverySignal: AbortSignal | null | undefined;
      const router = createX402Router({
        upstreams: [
          {
            name: "stalled",
            facilitatorUrl: "https://stalled.example",
            supportedKinds: [exact(BASE_MAINNET)],
          },
          {
            name: "healthy",
            facilitatorUrl: PRIMEV_FACILITATOR_URL,
            supportedKinds: [exact(ETHEREUM_MAINNET)],
          },
        ],
        fetch: async (url, init) => {
          if (url.hostname === "stalled.example") {
            discoverySignal = init.signal;
            return new Promise<Response>((_resolve, reject) => {
              init.signal!.addEventListener("abort", () => reject(init.signal!.reason), {
                once: true,
              });
            });
          }
          if (url.pathname === "/supported") {
            return Response.json({ kinds: [exact(ETHEREUM_MAINNET)] });
          }
          return Response.json({ isValid: true, success: true });
        },
      });
      const request =
        endpoint === "supported"
          ? new Request("https://router.example/supported")
          : paymentRequest(ETHEREUM_MAINNET, { endpoint: endpoint as "verify" | "settle" });
      const responsePromise = router.fetch(request);
      await vi.advanceTimersByTimeAsync(5000);
      const response = await responsePromise;
      expect(discoverySignal?.aborted).toBe(true);
      expect(response.status).toBe(200);
      if (endpoint === "supported") {
        await expect(response.json()).resolves.toMatchObject({
          kinds: [exact(BASE_MAINNET), exact(ETHEREUM_MAINNET)],
        });
      } else {
        await expect(response.json()).resolves.toMatchObject({ isValid: true });
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);

test("builds CDP JWT request targets for every facilitator endpoint", () => {
  expect(cdpRequestTarget("verify")).toEqual({
    requestHost: "api.cdp.coinbase.com",
    requestMethod: "POST",
    requestPath: "/platform/v2/x402/verify",
  });
  expect(cdpRequestTarget("supported", CDP_FACILITATOR_URL)).toMatchObject({
    requestMethod: "GET",
    requestPath: "/platform/v2/x402/supported",
  });
});

test("signs a CDP token for /supported, /verify, and /settle", async () => {
  const seen: string[] = [];
  const headers = await createCdpAuthHeaders({
    apiKeyId: "key-id",
    apiKeySecret: "key-secret",
    generateAuthorizationHeader: async (options) => {
      seen.push(options.endpoint);
      return `Bearer ${options.endpoint}`;
    },
  });

  expect(seen.toSorted()).toEqual(["settle", "supported", "verify"]);
  expect(headers).toEqual({
    settle: { [CDP_FORWARD_TOKEN_HEADER]: "Bearer settle" },
    supported: { [CDP_FORWARD_TOKEN_HEADER]: "Bearer supported" },
    verify: { [CDP_FORWARD_TOKEN_HEADER]: "Bearer verify" },
  });
});

async function payaiKey() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));

  return { publicKey: pair.publicKey, secret: `payai_sk_${btoa(String.fromCodePoint(...pkcs8))}` };
}

function decodeJwtPart(part: string) {
  return JSON.parse(atob(part.replaceAll("-", "+").replaceAll("_", "/")));
}

test("signs one PayAI JWT per endpoint with the claims PayAI expects", async () => {
  const { publicKey, secret } = await payaiKey();
  const headers = await createPayAIAuthHeaders({ apiKeyId: "kid-1", apiKeySecret: secret });
  const tokens = [headers.supported, headers.verify, headers.settle].map((part) =>
    part[PAYAI_FORWARD_TOKEN_HEADER].replace(/^Bearer /, ""),
  );

  for (const token of tokens) {
    const [header, payload, signature] = token.split(".");
    const signatureBytes = Uint8Array.from(
      atob(signature.replaceAll("-", "+").replaceAll("_", "/")),
      (char) => char.codePointAt(0)!,
    );
    const claims = decodeJwtPart(payload);

    expect(decodeJwtPart(header)).toEqual({ alg: "EdDSA", kid: "kid-1", typ: "JWT" });
    expect(claims).toMatchObject({ iss: "payai-merchant", sub: "kid-1" });
    expect(claims.exp - claims.iat).toBe(120);
    await expect(
      crypto.subtle.verify(
        "Ed25519",
        publicKey,
        signatureBytes,
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).resolves.toBe(true);
  }

  expect(new Set(tokens.map((token) => decodeJwtPart(token.split(".")[1]).jti)).size).toBe(3);
});

test("merges keys and the preference into one set of headers", async () => {
  const { secret } = await payaiKey();
  const preference = { eip155: ["cdp", "payai"], solana: ["payai", "dexter"] };
  const headers = await createRouterAuthHeaders({
    cdp: {
      apiKeyId: "cdp-id",
      apiKeySecret: "cdp-secret",
      generateAuthorizationHeader: async ({ endpoint }) => `Bearer cdp-${endpoint}`,
    },
    payai: { apiKeyId: "payai-id", apiKeySecret: secret },
    preference,
  });

  for (const endpoint of ["supported", "verify", "settle"] as const) {
    expect(headers[endpoint][CDP_FORWARD_TOKEN_HEADER]).toBe(`Bearer cdp-${endpoint}`);
    expect(headers[endpoint][PAYAI_FORWARD_TOKEN_HEADER]).toMatch(/^Bearer /);
    expect(parseRouterPreference(headers[endpoint][ROUTER_PREFERENCE_HEADER])).toEqual(preference);
  }
});

test("ignores malformed preference parts", () => {
  expect(parseRouterPreference(" eip155 = cdp , payai ;bad; =x;solana=")).toEqual({
    eip155: ["cdp", "payai"],
  });
  expect(parseRouterPreference(null)).toEqual({});
});

test("ignores preference keys inherited from Object", async () => {
  const { fetch, forwarded } = facilitators(baseEverywhere);
  const router = createX402Router({ fetch });
  const headers = { [ROUTER_PREFERENCE_HEADER]: "__proto__=dexter;eip155=cdp" };
  const response = await router.fetch(paymentRequest("constructor", { headers }));
  const parsed = parseRouterPreference(headers[ROUTER_PREFERENCE_HEADER]);

  expect(response.status).toBe(400);
  expect(Object.keys(parsed)).toEqual(["__proto__", "eip155"]);
  expect(Object.getPrototypeOf(parsed)).toBe(null);
  expect(forwarded()).toEqual([]);
});

test("leaves out a provider whose key is missing", async () => {
  const headers = await createRouterAuthHeaders({
    cdp: { apiKeyId: "", apiKeySecret: undefined },
    payai: { apiKeyId: undefined, apiKeySecret: "" },
    preference: { solana: ["dexter"] },
  });

  expect(headers.verify).toEqual({ [ROUTER_PREFERENCE_HEADER]: "solana=dexter" });
});

test("keeps the upstream message when the last upstream finds the payment invalid", async () => {
  const { fetch } = facilitators(baseEverywhere, {
    [DEXTER_FACILITATOR_URL]: {
      body: {
        invalidMessage: "bad signature",
        invalidReason: "invalid_exact_evm_signature",
        isValid: false,
      },
    },
    [PAYAI_FACILITATOR_URL]: { body: { error: "free_tier_exhausted" }, status: 403 },
  });
  const router = createX402Router({ fetch });

  expect(await bodyOf(await router.fetch(paymentRequest(BASE_MAINNET)))).toMatchObject({
    invalidMessage: "bad signature",
    invalidReason: "invalid_exact_evm_signature",
  });
});

test("tries the next upstream when reading a body fails", async () => {
  const { fetch: live, forwarded } = facilitators(baseEverywhere);
  const fetch = async (url: URL, init: RequestInit) => {
    const response = await live(url, init);

    if (url.href === `${PAYAI_FACILITATOR_URL}/settle`) {
      const broken = new ReadableStream({
        pull: (controller) => controller.error(new Error("reset")),
      });

      return new Response(broken, { status: 200 });
    }

    return response;
  };
  const router = createX402Router({ fetch });
  const response = await router.fetch(paymentRequest(BASE_MAINNET, { endpoint: "settle" }));

  expect(forwarded()).toEqual([PAYAI_FACILITATOR_URL, DEXTER_FACILITATOR_URL]);
  expect(await bodyOf(response)).toMatchObject({ by: DEXTER_FACILITATOR_URL, success: true });
});
