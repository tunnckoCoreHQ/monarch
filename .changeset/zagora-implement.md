---
"zagora": minor
---

Add `implement(contract, router)`, which returns the router with its exact type and fails to compile when a procedure is missing, extra, or has parameters that do not match the contract. Export the `Implemented<T>` type from `zagora/types` for direct `satisfies` use.
