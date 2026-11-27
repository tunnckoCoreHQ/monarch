---
"@tunnckocore/x402-router": minor
---

Route XRP payments through Sluzen and x402.org.

- New `sluzen` upstream for `exact` XRP payments on XRP Ledger Mainnet, `xrpl:0`. Sluzen settles only for a resource URL that the seller registered with Sluzen.
- XRP Ledger Testnet, `xrpl:1`, goes to x402.org.
- The default order is now `primev`, `cdp`, `payai`, `dexter`, `sluzen`, `x402`.
- `/supported` now drops a live kind that has no `x402Version`, such as Sluzen's `paychan`, and keeps the upstream's other live kinds. Before, one such kind made the router use the upstream's static list.
- New exports: `SLUZEN_FACILITATOR_URL`, `XRPL_MAINNET`, and `XRPL_TESTNET`.
