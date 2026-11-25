---
title: Upstreams
description: How the default router chooses facilitators.
---

Default routing is explicit.

| Rail                             | Default upstream | Notes                                |
| -------------------------------- | ---------------- | ------------------------------------ |
| Ethereum Mainnet                 | PrimeV           | 1.2s settlement, sponsored gas       |
| Base and CDP-supported EVM rails | CDP              | Requires seller-generated CDP JWT    |
| Solana Mainnet                   | PayAI, Dexter    | No auth; CDP when a CDP token is set |
| Public test/dev networks         | x402.org         | Used for public facilitator coverage |

The router looks at the x402 version, scheme, and network. It does not guess from hostname or path.

When several upstreams support a payment, the request goes to the first one in the list, as in the x402 SDK. An upstream whose forwarded token the request carries goes first. So a Solana payment with a CDP token goes to CDP, and one without goes to PayAI, then Dexter.

## Support discovery

`GET /supported` fetches upstream support and merges it into one response. Each kind comes from the upstream that the same request routes to, so a Solana `extra.feePayer` matches the facilitator that settles. If an upstream fails, the router falls back to its static support hints for that upstream.

An upstream with `limitToSupportedKinds: true` keeps only the live kinds that are in its `supportedKinds`. The default PayAI and Dexter upstreams use it, so only Solana Mainnet `exact` goes to them.

The response is cacheable by clients and CDNs. The hosted app returns cache headers for the support response.
