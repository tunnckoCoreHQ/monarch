# zagora

## 1.0.0

### Minor Changes

- [#182](https://github.com/tunnckoCoreHQ/monarch/pull/182) [`6bb3e7b`](https://github.com/tunnckoCoreHQ/monarch/commit/6bb3e7bf5bb9442e46da755553fc1ef5e3fdfbdf) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Make `.callable()` a type error until `.handler()` is set. A call that skips the types, like plain JS or `as any`, still never throws. Its procedure returns an `UNKNOWN_ERROR` that says no handler is set.

- [#182](https://github.com/tunnckoCoreHQ/monarch/pull/182) [`6bb3e7b`](https://github.com/tunnckoCoreHQ/monarch/commit/6bb3e7bf5bb9442e46da755553fc1ef5e3fdfbdf) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Add `implement(contract, router)`, which returns the router with its exact type and fails to compile when a procedure is missing, extra, or has parameters that do not match the contract. Export the `Implemented<T>` type from `zagora/types` for direct `satisfies` use.

### Patch Changes

- [#119](https://github.com/tunnckoCoreHQ/monarch/pull/119) [`f281d75`](https://github.com/tunnckoCoreHQ/monarch/commit/f281d754d6ea76b079f327acb5090e7a8af6beeb) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Clean up the source for the newly enabled lint rules. The behavior does not change.

- [#129](https://github.com/tunnckoCoreHQ/monarch/pull/129) [`1ae84ff`](https://github.com/tunnckoCoreHQ/monarch/commit/1ae84ff6be313576eb16e5be5ad34b5c333cfe19) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Publish a nightly of every package. The previous nightly run skipped some of them.

- [#126](https://github.com/tunnckoCoreHQ/monarch/pull/126) [`5665ba4`](https://github.com/tunnckoCoreHQ/monarch/commit/5665ba48e5a5a9a62f0876e517ad22b1edd3e177) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Add the `repository` field to `package.json`.

- [#118](https://github.com/tunnckoCoreHQ/monarch/pull/118) [`1565c09`](https://github.com/tunnckoCoreHQ/monarch/commit/1565c09c7aeb0585ed34ffd439e73986246bb67b) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Add the CI and coverage badges to the README.

- [#127](https://github.com/tunnckoCoreHQ/monarch/pull/127) [`d36be22`](https://github.com/tunnckoCoreHQ/monarch/commit/d36be22dedf62cf5450f2249c793991ccd9ca93a) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Show the Depot CI check, test, and build job badges in the README.

- [#132](https://github.com/tunnckoCoreHQ/monarch/pull/132) [`f32cf23`](https://github.com/tunnckoCoreHQ/monarch/commit/f32cf23fa820c2b2ed8337dc47f6b56416870816) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Add the license, Depot CI, and Socket Security badges to the README.

- [#175](https://github.com/tunnckoCoreHQ/monarch/pull/175) [`2e5deb6`](https://github.com/tunnckoCoreHQ/monarch/commit/2e5deb651cb53e63d3bd610f66713ea32863aaf9) Thanks [@olstenlarck](https://github.com/olstenlarck)! - Remove the `next` dist-tag from `publishConfig`. Version 1.0.0 publishes with `latest`.

- [#182](https://github.com/tunnckoCoreHQ/monarch/pull/182) [`6bb3e7b`](https://github.com/tunnckoCoreHQ/monarch/commit/6bb3e7bf5bb9442e46da755553fc1ef5e3fdfbdf) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - A handler that throws a value whose `kind` or `stack` getter throws now gets an `UNKNOWN_ERROR` result, with the thrown value in `cause`. Before, the getter error escaped the call. A sync call threw it, and an async call rejected with it.

- [#182](https://github.com/tunnckoCoreHQ/monarch/pull/182) [`6bb3e7b`](https://github.com/tunnckoCoreHQ/monarch/commit/6bb3e7bf5bb9442e46da755553fc1ef5e3fdfbdf) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Remove narration comments from the source, and rename internal helpers and types so their names say what the comments said. No behavior changes.

- [#124](https://github.com/tunnckoCoreHQ/monarch/pull/124) [`e01e236`](https://github.com/tunnckoCoreHQ/monarch/commit/e01e2363d16e36799f06b6802e3d264042ee5d8a) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Point the `repository` field at the monorepo. npm checks it against the provenance of a trusted publish from GitHub Actions.

- [#121](https://github.com/tunnckoCoreHQ/monarch/pull/121) [`feb6e65`](https://github.com/tunnckoCoreHQ/monarch/commit/feb6e65927e4a91c098363bf964c6e06e02e8bf0) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Fix defects from the review of the zagora migration. A callable no longer exposes the configured env values through `~zagora`. The cache stores only the validated output, so a failed call leaves nothing in the cache, and a cache hit returns the stored output without validating it again. The `SpreadTuple` type makes only the trailing elements that accept `undefined` optional, so required tuple arguments stay required.

- [#181](https://github.com/tunnckoCoreHQ/monarch/pull/181) [`ebd1f99`](https://github.com/tunnckoCoreHQ/monarch/commit/ebd1f99befa06a61178b8b5dd7d24169a03d681e) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Fix two type gaps from [#180](https://github.com/tunnckoCoreHQ/monarch/issues/180):

  - A procedure whose input is not a tuple, but whose input type accepts `undefined`, such as `z.number().default(10)` or `.optional()`, now takes an optional argument. Before, TypeScript required the argument, though the runtime already used the default.
  - `isValidationError`, `isInternalError`, and `isDefinedError` now narrow a result error to the matching members only, so the `false` branch keeps the other members. Before, `isDefinedError` narrowed its `false` branch to `never`, and `isValidationError` kept a validation error with typed `key` in its `false` branch.

- [#176](https://github.com/tunnckoCoreHQ/monarch/pull/176) [`85c423e`](https://github.com/tunnckoCoreHQ/monarch/commit/85c423e3695cd52d822bd6a570a630cefa82c5c2) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Fix wrong results and type mismatches found in the v1 review.

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
