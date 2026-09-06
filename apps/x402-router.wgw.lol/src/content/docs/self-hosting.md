---
title: Self-hosting
description: Deploy the router on any Fetch API runtime.
---

The router is a Fetch handler. Cloudflare Workers is the default deployment target for `x402-router.wgw.lol`, but the package is not tied to Cloudflare.

```ts
import { createX402Router } from "@tunnckocore/x402-router";

const handler = createX402Router();

export default {
  fetch(request: Request) {
    return handler.fetch(request);
  },
};
```

## Runtime requirements

- Standard `Request` and `Response`.
- `fetch` for upstream facilitator calls.
- No database.
- No router-side secrets.

Use `createX402Router({ upstreams })` if you want to add or replace facilitators.

## Health checks

```txt
GET /health
GET /healthz
```

Both return a small JSON health response from the router package.
