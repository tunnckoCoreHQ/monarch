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

CDP-routed requests need a short-lived bearer token in the forwarded CDP header. Use `createCdpAuthHeaders` from `@tunnckocore/x402-router/cdp` with the normal x402 facilitator client.

## Install

```bash
bun add @tunnckocore/x402-router
```

The package exposes:

- `createX402Router` for self-hosting.
- `fetch` for a default Fetch handler.
- `createCdpAuthHeaders` for seller-side CDP pass-through auth.
