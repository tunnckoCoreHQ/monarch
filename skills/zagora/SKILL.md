---
name: zagora
description: Write and use zagora procedures, TypeScript functions that never throw and return `{ ok, data, error }`, with Standard Schema validation and typed errors. Use when code imports `zagora`, or when building a type-safe, error-safe function, library, or SDK.
---

# zagora

zagora builds plain TypeScript functions from a chain: input schema, output schema, error schemas, and a handler. A call never throws. It returns a result: `{ ok: true, data }` or `{ ok: false, isTypedError, error }`. There is no router and no network layer.

The full docs are at https://zagora-docs.equator-owl-studio.workers.dev. Every page has a Markdown copy at its path plus `.md`, and https://zagora-docs.equator-owl-studio.workers.dev/llms.txt lists them all.

## Install

```sh
npm install zagora@nightly zod
```

zagora is ESM-only. Any Standard Schema library works: Zod, Valibot, ArkType, and others. One procedure can mix them.

## Write a procedure

```ts
import { z } from "zod";
import { zagora } from "zagora";

export const getUser = zagora()
  .input(z.tuple([z.string(), z.number().default(18)]))
  .output(z.object({ name: z.string(), age: z.number() }))
  .errors({ NOT_FOUND: z.object({ name: z.string() }) })
  .handler(({ errors }, name, age) => {
    if (name === "nobody") {
      throw errors.NOT_FOUND({ name });
    }
    return { name, age };
  })
  .callable();

const result = getUser("Ada"); // age defaults to 18
if (result.ok) {
  result.data; // { name: string; age: number }
} else if (result.error.kind === "NOT_FOUND") {
  result.error.name;
}
```

- The handler gets an options object first, `{ context, errors, env }`, then the validated arguments.
- Every builder method returns a new builder. A shared partial chain is safe to reuse.
- `.callable({ context, cache, env })` makes the function. Call it once per request when the context comes from the request.

## Input shapes

- No `.input()`: the function takes no arguments.
- A tuple schema spreads into arguments. Trailing elements with a default or `.optional()` become optional parameters. Spreading works for Zod and Valibot tuples only.
- Any other schema, including an array, is one argument. When its input type accepts `undefined`, from `.default()` or `.optional()`, the argument is optional.
- The function accepts the schema's input type. The handler gets the output type, so defaults are filled and transforms are applied.

## Errors

A failed result has one of three kinds of error:

| Kind | Cause | Fields |
| --- | --- | --- |
| `VALIDATION_ERROR` | Input, output, env, or error data failed its schema | `message`, `issues`, `key` (the error kind, for bad error data) |
| `UNKNOWN_ERROR` | The handler threw or rejected, a schema or cache adapter failed | `message`, `cause`, `stack` |
| A declared kind, such as `NOT_FOUND` | The handler threw a declared error | The fields of its schema, plus `kind` |

- Error map keys must be uppercase. TypeScript rejects other keys.
- Throw the helper: `throw errors.NOT_FOUND({ ... })`. Its return type is `never`.
- zagora validates the error data with the kind's schema. Bad data gives a `VALIDATION_ERROR` with `key` set to the kind.
- `isTypedError` is `true` only for a declared kind.
- Guards come from `zagora/errors`: `isValidationError`, `isInternalError`, `isDefinedError`, `isZagoraError`. On `result.error`, each guard narrows to the matching kinds in any order.

## Async

- A sync handler with sync schemas returns a result, not a `Promise`.
- An `async` handler, or a schema marked `async: true` (Valibot async schemas), returns a `Promise` on every call.
- A Zod schema with an async refinement returns a `Promise` at runtime, but its type says sync. `await` it.
- An async cache adapter makes the type `Result | Promise<Result>`. `await` it.
- When any part can be async, `await` every call.

## Context, env, and cache

- `.context<T>(initial?)` types the context. `.callable({ context })` deep-merges plain objects over the initial value. Class instances replace it whole.
- `.env(schema, values?)` validates env vars on every call. Pass `process.env` as the second argument. `.callable({ env: process.env })` type-checks only when every schema key is optional or has a default. Async env schemas give an `UNKNOWN_ERROR`.
- `.cache(adapter)` or `.callable({ cache })` takes any object with `has`, `get`, and `set`, such as a `Map`. Only valid output is stored. The key hashes the arguments, the options object, the schemas, and the handler source with `node:crypto`, so give procedures with different captured variables their own cache.

## Instance options

- `zagora({ disableOptions: true })`: the handler gets only the arguments. No context, error helpers, or env.
- `zagora({ autoCallable: true })`: `.handler()` returns the function, with no `.callable()` step. Pass env values to `.env()` directly.
