---
"@tunnckocore/ethscriptions-server": patch
---

Use `@tunnckocore/ethscriptions-core` instead of the `ethscriptions` package. The `/estimate` options are now snake_case (`eth_price`, `gas_price`, `base_fee`, `priority_fee`, `buffer_fee`), and a `baseURL` query param on the list routes replaces the upstream for that request.
