---
title: Getting Started
description: Use the hosted router or deploy your own.
---

Use the hosted facilitator URL:

```txt
https://x402-router.wgw.lol
```

The router supports x402 v2 only.

## Endpoints

```txt
GET  /supported
POST /verify
POST /settle
GET  /health
GET  /healthz
```

`/supported` is safe to call without auth. `/verify` and `/settle` route by x402 version, scheme, and network.

The router works without keys. A CDP token or a PayAI key adds that facilitator. Use `createRouterAuthHeaders` with the normal x402 facilitator client. [Integration](/docs/integration.md) shows how.

## Install

```bash
bun add @tunnckocore/x402-router
```

The package exposes:

- `createX402Router` for self-hosting.
- `fetch` for a default Fetch handler.
- `createRouterAuthHeaders` for the seller headers: CDP token, PayAI key, and preference.
- `createCdpAuthHeaders` from `@tunnckocore/x402-router/cdp` and `createPayAIAuthHeaders` from `@tunnckocore/x402-router/payai` for one facilitator alone.
