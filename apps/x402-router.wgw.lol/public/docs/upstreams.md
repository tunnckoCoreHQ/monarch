---
title: Upstreams
description: How the default router chooses facilitators.
---

Default routing is explicit.

| Rail                               | Default upstream | Notes                                |
| ---------------------------------- | ---------------- | ------------------------------------ |
| Ethereum Mainnet                   | PrimeV           | 1.2s settlement, sponsored gas       |
| Base and CDP-supported EVM rails   | CDP              | Requires seller-generated CDP JWT    |
| Solana and CDP-supported SVM rails | CDP              | Same pass-through auth model         |
| Public test/dev networks           | x402.org         | Used for public facilitator coverage |

The router looks at the x402 version, scheme, and network. It does not guess from hostname or path.

## Support discovery

`GET /supported` fetches upstream support and merges it into one response. If an upstream fails, the router falls back to its static support hints for that upstream.

The response is cacheable by clients and CDNs. The hosted app returns cache headers for the support response.
