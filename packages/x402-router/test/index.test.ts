import { expect, test } from "vite-plus/test";

import { CDP_FACILITATOR_URL, cdpRequestTarget, createCdpAuthHeaders } from "../src/cdp";
import {
  BASE_MAINNET,
  BASE_SEPOLIA,
  CDP_FORWARD_TOKEN_HEADER,
  createX402Router,
  ETHEREUM_MAINNET,
  PRIMEV_FACILITATOR_URL,
} from "../src/index";

function paymentRequest(network: string, scheme = "exact", x402Version = 2) {
  return new Request("https://router.example/verify", {
    body: JSON.stringify({
      paymentPayload: {},
      paymentRequirements: {
        network,
        scheme,
      },
      x402Version,
    }),
    method: "POST",
  });
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
  const body = (await response.json()) as { kinds: unknown[] };

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
  const body = (await response.json()) as { kinds: unknown[] };

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

test("routes ethereum mainnet to Primev without a forwarded token", async () => {
  const calls: string[] = [];
  const router = createX402Router({
    fetch: async (url) => {
      calls.push(url.href);
      if (url.href.endsWith("/supported")) {
        return Response.json({
          kinds: [{ network: ETHEREUM_MAINNET, scheme: "exact", x402Version: 2 }],
        });
      }

      return Response.json({ ok: true });
    },
    upstreams: [
      {
        facilitatorUrl: PRIMEV_FACILITATOR_URL,
        name: "primev",
        supportedKinds: [{ network: ETHEREUM_MAINNET, scheme: "exact", x402Version: 2 }],
      },
    ],
  });

  const response = await router.fetch(paymentRequest(ETHEREUM_MAINNET));

  expect(response.status).toBe(200);
  expect(calls).toEqual([
    `${PRIMEV_FACILITATOR_URL}/supported`,
    `${PRIMEV_FACILITATOR_URL}/verify`,
  ]);
});

test("routes by x402 version, scheme, and network from live supported responses", async () => {
  const calls: string[] = [];
  const router = createX402Router({
    fetch: async (url) => {
      calls.push(url.href);
      if (url.href.endsWith("/supported")) {
        return Response.json({
          kinds: [{ network: BASE_SEPOLIA, scheme: "upto", x402Version: 2 }],
        });
      }

      return Response.json({ ok: true });
    },
    upstreams: [
      {
        facilitatorUrl: "https://x402.org/facilitator",
        name: "x402-testnet",
        supportedKinds: [{ network: BASE_SEPOLIA, scheme: "exact", x402Version: 2 }],
      },
    ],
  });

  const response = await router.fetch(paymentRequest(BASE_SEPOLIA, "upto"));

  expect(response.status).toBe(200);
  expect(calls).toEqual([
    "https://x402.org/facilitator/supported",
    "https://x402.org/facilitator/verify",
  ]);
});

test("prefers x402.org before CDP when no CDP token is present", async () => {
  const calls: string[] = [];
  const router = createX402Router({
    fetch: async (url) => {
      calls.push(url.href);
      if (url.href.endsWith("/supported")) {
        return Response.json({
          kinds: [{ network: BASE_MAINNET, scheme: "exact", x402Version: 2 }],
        });
      }

      return Response.json({ ok: true });
    },
    upstreams: [
      {
        facilitatorUrl: "https://x402.org/facilitator",
        name: "x402-org",
        supportedKinds: [{ network: BASE_MAINNET, scheme: "exact", x402Version: 2 }],
      },
      {
        auth: { header: CDP_FORWARD_TOKEN_HEADER, type: "forwarded-bearer" },
        facilitatorUrl: CDP_FACILITATOR_URL,
        name: "cdp",
        supportedKinds: [{ network: BASE_MAINNET, scheme: "exact", x402Version: 2 }],
      },
    ],
  });
  const response = await router.fetch(paymentRequest(BASE_MAINNET));

  expect(response.status).toBe(200);
  expect(calls).toEqual([
    "https://x402.org/facilitator/supported",
    "https://x402.org/facilitator/verify",
  ]);
});

test("prefers CDP over x402.org when a CDP token is present", async () => {
  const calls: string[] = [];
  const authHeaders: string[] = [];
  const router = createX402Router({
    fetch: async (url, init) => {
      calls.push(url.href);
      authHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
      if (url.href.endsWith("/supported")) {
        return Response.json({
          kinds: [{ network: BASE_MAINNET, scheme: "exact", x402Version: 2 }],
        });
      }

      return Response.json({ ok: true });
    },
    upstreams: [
      {
        facilitatorUrl: "https://x402.org/facilitator",
        name: "x402-org",
        supportedKinds: [{ network: BASE_MAINNET, scheme: "exact", x402Version: 2 }],
      },
      {
        auth: { header: CDP_FORWARD_TOKEN_HEADER, type: "forwarded-bearer" },
        facilitatorUrl: CDP_FACILITATOR_URL,
        name: "cdp",
        supportedKinds: [{ network: BASE_MAINNET, scheme: "exact", x402Version: 2 }],
      },
    ],
  });
  const request = paymentRequest(BASE_MAINNET);

  request.headers.set(CDP_FORWARD_TOKEN_HEADER, "Bearer signed-for-cdp-upstream");

  const response = await router.fetch(request);

  expect(response.status).toBe(200);
  expect(calls).toEqual([
    "https://x402.org/facilitator/supported",
    `${CDP_FACILITATOR_URL}/supported`,
    `${CDP_FACILITATOR_URL}/verify`,
  ]);
  expect(authHeaders).toEqual([
    "",
    "Bearer signed-for-cdp-upstream",
    "Bearer signed-for-cdp-upstream",
  ]);
});

test("requires a forwarded token for CDP-routed networks", async () => {
  const router = createX402Router({
    fetch: async () => Response.json({ ok: true }),
    supported: {
      kinds: [{ network: BASE_MAINNET, scheme: "exact", x402Version: 2 }],
    },
  });

  const response = await router.fetch(paymentRequest(BASE_MAINNET));

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ error: "missing_forwarded_bearer" });
});

test("forwards CDP-routed requests with the forwarded bearer", async () => {
  const authHeaders: string[] = [];
  const router = createX402Router({
    fetch: async (_url: URL, init: RequestInit) => {
      authHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({ ok: true });
    },
    supported: {
      kinds: [{ network: BASE_MAINNET, scheme: "exact", x402Version: 2 }],
    },
  });
  const request = paymentRequest(BASE_MAINNET);

  request.headers.set(CDP_FORWARD_TOKEN_HEADER, "Bearer signed-for-cdp-upstream");

  const response = await router.fetch(request);

  expect(response.status).toBe(200);
  expect(authHeaders).toEqual(["Bearer signed-for-cdp-upstream"]);
});

test("builds CDP JWT request targets for the upstream facilitator paths", () => {
  expect(cdpRequestTarget("verify")).toEqual({
    requestHost: "api.cdp.coinbase.com",
    requestMethod: "POST",
    requestPath: "/platform/v2/x402/verify",
  });
  expect(cdpRequestTarget("settle", CDP_FACILITATOR_URL)).toMatchObject({
    requestPath: "/platform/v2/x402/settle",
  });
});

test("creates HTTPFacilitatorClient auth headers for CDP pass-through routing", async () => {
  const seen: string[] = [];
  const headers = await createCdpAuthHeaders({
    apiKeyId: "key-id",
    apiKeySecret: "key-secret",
    generateAuthorizationHeader: async (options) => {
      seen.push(options.endpoint);
      return `Bearer ${options.endpoint}`;
    },
  });

  expect(seen).toEqual(["settle", "verify"]);
  expect(headers.settle).toEqual({ [CDP_FORWARD_TOKEN_HEADER]: "Bearer settle" });
  expect(headers.verify).toEqual({ [CDP_FORWARD_TOKEN_HEADER]: "Bearer verify" });
  expect(headers.supported).toEqual({});
});

test("uses a custom token header for default CDP routing and preflight", async () => {
  const authorizations: (string | null)[] = [];
  const router = createX402Router({
    forwardedBearerHeader: "X-Seller-Token",
    supported: { kinds: [{ network: BASE_MAINNET, scheme: "exact", x402Version: 2 }] },
    fetch: async (_url, init) => {
      authorizations.push(new Headers(init.headers).get("authorization"));
      return Response.json({ ok: true });
    },
  });
  const preflight = await router.fetch(
    new Request("https://router.example/verify", { method: "OPTIONS" }),
  );
  expect(preflight.headers.get("access-control-allow-headers")).toContain("x-seller-token");

  const missing = await router.fetch(paymentRequest(BASE_MAINNET));
  expect(missing.status).toBe(401);
  await expect(missing.json()).resolves.toMatchObject({
    message: "missing X-Seller-Token header for cdp-mainnet",
  });

  const request = paymentRequest(BASE_MAINNET);
  request.headers.set("X-Seller-Token", "Bearer custom-token");
  expect((await router.fetch(request)).status).toBe(200);
  expect(authorizations).toEqual(["Bearer custom-token"]);
});

test("keeps explicit upstream token headers ahead of the router default", async () => {
  const router = createX402Router({
    forwardedBearerHeader: "X-Seller-Token",
    supported: { kinds: [{ network: BASE_MAINNET, scheme: "exact", x402Version: 2 }] },
    upstreams: [
      {
        name: "custom",
        facilitatorUrl: CDP_FACILITATOR_URL,
        auth: { type: "forwarded-bearer", header: "X-Upstream-Token" },
        supportedKinds: [{ network: BASE_MAINNET, scheme: "exact", x402Version: 2 }],
      },
    ],
    fetch: async (_url, init) =>
      Response.json({ authorization: new Headers(init.headers).get("authorization") }),
  });
  const preflight = await router.fetch(
    new Request("https://router.example/verify", { method: "OPTIONS" }),
  );
  expect(preflight.headers.get("access-control-allow-headers")).toContain("x-upstream-token");
  const request = paymentRequest(BASE_MAINNET);
  request.headers.set("X-Seller-Token", "Bearer wrong-token");
  request.headers.set("X-Upstream-Token", "Bearer upstream-token");
  await expect((await router.fetch(request)).json()).resolves.toEqual({
    authorization: "Bearer upstream-token",
  });
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
            supportedKinds: [{ network: BASE_MAINNET, scheme: "exact", x402Version: 2 }],
          },
          {
            name: "healthy",
            facilitatorUrl: PRIMEV_FACILITATOR_URL,
            supportedKinds: [{ network: ETHEREUM_MAINNET, scheme: "exact", x402Version: 2 }],
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
            return Response.json({
              kinds: [{ network: ETHEREUM_MAINNET, scheme: "exact", x402Version: 2 }],
            });
          }
          return Response.json({ ok: true });
        },
      });
      const request =
        endpoint === "supported"
          ? new Request("https://router.example/supported")
          : new Request(`https://router.example/${endpoint}`, paymentRequest(ETHEREUM_MAINNET));
      const responsePromise = router.fetch(request);
      await vi.advanceTimersByTimeAsync(5000);
      const response = await responsePromise;
      expect(discoverySignal?.aborted).toBe(true);
      expect(response.status).toBe(200);
      if (endpoint === "supported") {
        await expect(response.json()).resolves.toMatchObject({
          kinds: [
            { network: BASE_MAINNET, scheme: "exact", x402Version: 2 },
            { network: ETHEREUM_MAINNET, scheme: "exact", x402Version: 2 },
          ],
        });
      } else {
        await expect(response.json()).resolves.toEqual({ ok: true });
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);
