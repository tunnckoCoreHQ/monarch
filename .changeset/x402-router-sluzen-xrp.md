---
"@tunnckocore/x402-router": minor
---

Route XRP payments on XRP Ledger Mainnet through Sluzen.

- The new `sluzen` upstream takes `exact` XRP payments on `xrpl:0`. Sluzen settles only for a resource URL that the seller registered with Sluzen.
- The default order is now `primev`, `cdp`, `payai`, `dexter`, `sluzen`, `x402`.
- `/supported` now drops a live kind that has no `x402Version`, such as Sluzen's `paychan`, and keeps the upstream's other live kinds. Before, one such kind made the router use the upstream's static list.
- The package now exports `SLUZEN_FACILITATOR_URL` and `XRPL_MAINNET`.
