# zagora

## 1.0.0

### Patch Changes

- [#119](https://github.com/tunnckoCoreHQ/monarch/pull/119) [`f281d75`](https://github.com/tunnckoCoreHQ/monarch/commit/f281d754d6ea76b079f327acb5090e7a8af6beeb) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Clean up the source for the newly enabled lint rules. The behavior does not change.

- [#129](https://github.com/tunnckoCoreHQ/monarch/pull/129) [`1ae84ff`](https://github.com/tunnckoCoreHQ/monarch/commit/1ae84ff6be313576eb16e5be5ad34b5c333cfe19) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Publish a nightly of every package. The previous nightly run skipped some of them.

- [#126](https://github.com/tunnckoCoreHQ/monarch/pull/126) [`5665ba4`](https://github.com/tunnckoCoreHQ/monarch/commit/5665ba48e5a5a9a62f0876e517ad22b1edd3e177) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Add the `repository` field to `package.json`.

- [#118](https://github.com/tunnckoCoreHQ/monarch/pull/118) [`1565c09`](https://github.com/tunnckoCoreHQ/monarch/commit/1565c09c7aeb0585ed34ffd439e73986246bb67b) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Add the CI and coverage badges to the README.

- [#127](https://github.com/tunnckoCoreHQ/monarch/pull/127) [`d36be22`](https://github.com/tunnckoCoreHQ/monarch/commit/d36be22dedf62cf5450f2249c793991ccd9ca93a) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Show the Depot CI check, test, and build job badges in the README.

- [#132](https://github.com/tunnckoCoreHQ/monarch/pull/132) [`f32cf23`](https://github.com/tunnckoCoreHQ/monarch/commit/f32cf23fa820c2b2ed8337dc47f6b56416870816) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Add the license, Depot CI, and Socket Security badges to the README.

- [#175](https://github.com/tunnckoCoreHQ/monarch/pull/175) [`2e5deb6`](https://github.com/tunnckoCoreHQ/monarch/commit/2e5deb651cb53e63d3bd610f66713ea32863aaf9) Thanks [@olstenlarck](https://github.com/olstenlarck)! - Remove the `next` dist-tag from `publishConfig`. Version 1.0.0 publishes with `latest`.

- [#124](https://github.com/tunnckoCoreHQ/monarch/pull/124) [`e01e236`](https://github.com/tunnckoCoreHQ/monarch/commit/e01e2363d16e36799f06b6802e3d264042ee5d8a) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Point the `repository` field at the monorepo. npm checks it against the provenance of a trusted publish from GitHub Actions.

- [#121](https://github.com/tunnckoCoreHQ/monarch/pull/121) [`feb6e65`](https://github.com/tunnckoCoreHQ/monarch/commit/feb6e65927e4a91c098363bf964c6e06e02e8bf0) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Fix defects from the review of the zagora migration. A callable no longer exposes the configured env values through `~zagora`. The cache stores only the validated output, so a failed call leaves nothing in the cache, and a cache hit returns the stored output without validating it again. The `SpreadTuple` type makes only the trailing elements that accept `undefined` optional, so required tuple arguments stay required.

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
