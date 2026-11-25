---
"@tunnckocore/x402-router": minor
---

Route Solana Mainnet payments to PayAI, then Dexter, when the request has no CDP token. A request with a CDP token still goes to CDP. `GET /supported` now takes each kind from the upstream that the same request routes to, so the Solana fee payer matches the facilitator that settles. The new `limitToSupportedKinds` upstream option keeps only the live kinds listed in `supportedKinds`.
