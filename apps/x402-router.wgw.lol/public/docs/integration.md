---
title: Integration
description: Normal x402 integration with a router-backed facilitator URL.
---

The router is designed to fit the regular x402 server path. The important part is the facilitator client:

```ts
import { createCdpAuthHeaders } from "@tunnckocore/x402-router/cdp";

const facilitator = new HTTPFacilitatorClient({
  url: "https://x402-router.wgw.lol",
  createAuthHeaders: () =>
    createCdpAuthHeaders({
      apiKeyId: process.env.CDP_API_KEY_ID!,
      apiKeySecret: process.env.CDP_API_KEY_SECRET!,
    }),
});
```

Then keep the usual x402 resource setup:

```ts
const server = new x402ResourceServer(facilitator)
  .register(ETHEREUM_MAINNET, new ExactEvmScheme())
  .register(BASE_MAINNET, new ExactEvmScheme())
  .register(SOLANA_MAINNET, new ExactSvmScheme());
```

The middleware still calls `/supported`, `/verify`, and `/settle`. The router chooses the upstream only after reading the payment request.

## CDP pass-through

CDP auth stays on the seller server. The helper generates a short-lived CDP JWT and sends it to the router as a forwarded bearer header. The router only forwards it when a request routes to CDP.

PrimeV-routed Ethereum Mainnet requests do not need that header.
