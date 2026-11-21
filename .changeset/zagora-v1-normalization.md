---
"zagora": patch
---

Fix wrong results and type mismatches found in the v1 review.

- A `__proto__` key in a context or env override stays an own property and does not change the prototype of the merged object.
- Validation messages print Standard Schema path segments of the form `{ key }`, and symbol keys.
- A thrown error with a non-string `kind` gives an `UNKNOWN_ERROR` result.
- `.callable({ env: process.env })` no longer throws on Node.
- A handler that returns a thenable, such as a query builder, is awaited.
- A procedure with an `async` handler always returns a Promise.
- A tuple schema with a transform passes the transform output to the handler as one argument, for Zod and Valibot.
- A tuple whose elements are all optional or defaulted spreads into arguments in the types too.
- `.callable()` accepts only a plain object as `context`.
- The published types no longer need Node types.
- Cache keys support `bigint` inputs.
- An auto-callable procedure has `~zagora` in its type.
- The README documents the limits of JSON cache keys.
