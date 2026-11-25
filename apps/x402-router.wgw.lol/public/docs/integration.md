---
title: Integration
description: Normal x402 integration with a router-backed facilitator URL.
---

The router fits the regular x402 server path. Point the facilitator client at the router, and add the router headers:

```ts
import { createRouterAuthHeaders } from "@tunnckocore/x402-router";

const facilitator = new HTTPFacilitatorClient({
  url: "https://x402-router.wgw.lol",
  createAuthHeaders: () =>
    createRouterAuthHeaders({
      cdp: {
        apiKeyId: process.env.CDP_API_KEY_ID!,
        apiKeySecret: process.env.CDP_API_KEY_SECRET!,
      },
      payai: {
        apiKeyId: process.env.PAYAI_API_KEY_ID!,
        apiKeySecret: process.env.PAYAI_API_KEY_SECRET!,
      },
      preference: { eip155: ["cdp", "payai"], solana: ["payai", "dexter"] },
    }),
});
```

Each part is optional. With no keys and no preference, leave out `createAuthHeaders`. The router then uses PayAI's free credits, then Dexter.

Then keep the usual x402 resource setup:

```ts
const server = new x402ResourceServer(facilitator)
  .register(ETHEREUM_MAINNET, new ExactEvmScheme())
  .register(BASE_MAINNET, new ExactEvmScheme())
  .register(SOLANA_MAINNET, new ExactSvmScheme());
```

The middleware still calls `/supported`, `/verify`, and `/settle`. The router picks the upstream per payment. [Upstreams](/docs/upstreams.md) has the order and the fallback rules.

## Keys

Keys stay on the seller server. The helpers sign short-lived JWTs there and send them to the router:

- `createCdpAuthHeaders` sends a CDP JWT in `X-Forwarded-CDP-Token`. It signs one for `/supported`, `/verify`, and `/settle`.
- `createPayAIAuthHeaders` sends a PayAI JWT in `X-Forwarded-PayAI-Token`. It signs a new JWT for each endpoint, because PayAI rejects a reused one.

The router copies each token to `authorization` only for its own upstream. It stores no keys.
