---
"@tunnckocore/x402-router": minor
---

Route every standard x402 payment across PrimeV, CDP, PayAI, Dexter, and x402.org, with fallback.

- `/supported` merges all live `exact`, `upto`, and `batch-settlement` kinds, testnets included. Each kind comes from the first upstream in that network's order.
- The order starts from `primev`, `cdp`, `payai`, `dexter`, `x402`. The seller's preference moves named upstreams to the front, upstreams with a key in the request go first, and CDP wins over PayAI when both keys are present.
- A payment that names its facilitator, through `feePayer`, `facilitatorAddress`, `receiverAuthorizer`, or `assetTransferMethod`, goes only to an upstream that matches. This fixes Solana payments for sellers with a CDP token, which went to CDP with PayAI's fee payer.
- When an upstream is out of credits, down, rejects the key, or does not support the payment, the router tries the next one. It stops when the payment itself is invalid. Failures carry a buyer message and `extra.router.tried`.
- New `createPayAIAuthHeaders` in `@tunnckocore/x402-router/payai`, and `createRouterAuthHeaders` for CDP, PayAI, and the preference together.
- `createCdpAuthHeaders` now signs a token for `/supported` too.
- Removed `limitToSupportedKinds`, `defaultX402SupportedResponse`, and the `supported` and `bazaar` fields of the CDP helper.
