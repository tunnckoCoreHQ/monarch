---
"zagora": patch
---

Fix two type gaps from [#180](https://github.com/tunnckoCoreHQ/monarch/issues/180):

- A procedure whose input is not a tuple, but whose input type accepts `undefined`, such as `z.number().default(10)` or `.optional()`, now takes an optional argument. Before, TypeScript required the argument, though the runtime already used the default.
- `isValidationError`, `isInternalError`, and `isDefinedError` now narrow a result error to the matching members only, so the `false` branch keeps the other members. Before, `isDefinedError` narrowed its `false` branch to `never`, and `isValidationError` kept a validation error with typed `key` in its `false` branch.
