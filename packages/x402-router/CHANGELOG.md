# @tunnckocore/x402-router

## 0.3.0

### Minor Changes

- [#197](https://github.com/tunnckoCoreHQ/monarch/pull/197) [`da72ec4`](https://github.com/tunnckoCoreHQ/monarch/commit/da72ec4e15d92624a3e576cb9f0a622cac3c3e1a) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Route every standard x402 payment across PrimeV, CDP, PayAI, Dexter, and x402.org, with fallback.

  - `/supported` merges all live `exact`, `upto`, and `batch-settlement` kinds, testnets included. Each kind comes from the first upstream in that network's order.
  - The order starts from `primev`, `cdp`, `payai`, `dexter`, `x402`. The seller's preference moves named upstreams to the front, upstreams with a key in the request go first, and CDP wins over PayAI when both keys are present.
  - A payment that names its facilitator, through `feePayer`, `facilitatorAddress`, `receiverAuthorizer`, or `assetTransferMethod`, goes only to an upstream that matches. This fixes Solana payments for sellers with a CDP token, which went to CDP with PayAI's fee payer.
  - When an upstream is out of credits, down, rejects the key, or does not support the payment, the router tries the next one. It stops when the payment itself is invalid. Failures carry a buyer message and `extra.router.tried`.
  - New `createPayAIAuthHeaders` in `@tunnckocore/x402-router/payai`, and `createRouterAuthHeaders` for CDP, PayAI, and the preference together.
  - `createCdpAuthHeaders` now signs a token for `/supported` too.
  - Removed `limitToSupportedKinds` and `defaultX402SupportedResponse`.

- [#199](https://github.com/tunnckoCoreHQ/monarch/pull/199) [`908e103`](https://github.com/tunnckoCoreHQ/monarch/commit/908e10392b90befed7108754d1e7740890c2c048) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Route XRP payments on XRP Ledger Mainnet through Sluzen.

  - The new `sluzen` upstream takes `exact` XRP payments on `xrpl:0`. Sluzen settles only for a resource URL that the seller registered with Sluzen.
  - The default order is now `primev`, `cdp`, `payai`, `dexter`, `sluzen`, `x402`.
  - `/supported` now drops a live kind that has no `x402Version`, such as Sluzen's `paychan`, and keeps the upstream's other live kinds. Before, one such kind made the router use the upstream's static list.
  - The package now exports `SLUZEN_FACILITATOR_URL` and `XRPL_MAINNET`.

- [#196](https://github.com/tunnckoCoreHQ/monarch/pull/196) [`668a1c9`](https://github.com/tunnckoCoreHQ/monarch/commit/668a1c939f4708c5ce8f5bda9c81e4c593d86dd1) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Route Solana Mainnet payments to PayAI, then Dexter, when the request has no CDP token. A request with a CDP token still goes to CDP. `GET /supported` now takes each kind from the upstream that the same request routes to, so the Solana fee payer matches the facilitator that settles. The new `limitToSupportedKinds` upstream option keeps only the live kinds listed in `supportedKinds`.

## 0.2.0

### Minor Changes

- [#102](https://github.com/tunnckoCoreHQ/monarch/pull/102) [`f0bd4be`](https://github.com/tunnckoCoreHQ/monarch/commit/f0bd4be2aceeb67a63d92bcee7f2ad9fa91ccd60) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - minor migration of the monorepo tooling - from Vite+ to Turborepo and Ultracite. VLT public tunnckocore-scoped packages

### Patch Changes

- [#68](https://github.com/tunnckoCoreHQ/monarch/pull/68) [`1ca33e6`](https://github.com/tunnckoCoreHQ/monarch/commit/1ca33e640d727d196d18f0f9d1ca8946c43ecf45) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Validate facilitator support metadata and payment request objects before reading their fields.

- [#122](https://github.com/tunnckoCoreHQ/monarch/pull/122) [`0d0ca0c`](https://github.com/tunnckoCoreHQ/monarch/commit/0d0ca0cfa2841a4a819657cee6c74b0ca2627343) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Write complex array types as `Array<T>`. The behavior does not change.

- [#119](https://github.com/tunnckoCoreHQ/monarch/pull/119) [`f281d75`](https://github.com/tunnckoCoreHQ/monarch/commit/f281d754d6ea76b079f327acb5090e7a8af6beeb) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Clean up the source for the newly enabled lint rules. The behavior does not change.

- [#129](https://github.com/tunnckoCoreHQ/monarch/pull/129) [`1ae84ff`](https://github.com/tunnckoCoreHQ/monarch/commit/1ae84ff6be313576eb16e5be5ad34b5c333cfe19) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Publish a nightly of every package. The previous nightly run skipped some of them.

- [#126](https://github.com/tunnckoCoreHQ/monarch/pull/126) [`5665ba4`](https://github.com/tunnckoCoreHQ/monarch/commit/5665ba48e5a5a9a62f0876e517ad22b1edd3e177) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Add the `repository` field to `package.json`.

- [#118](https://github.com/tunnckoCoreHQ/monarch/pull/118) [`1565c09`](https://github.com/tunnckoCoreHQ/monarch/commit/1565c09c7aeb0585ed34ffd439e73986246bb67b) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Add the CI and coverage badges to the README.

- [#127](https://github.com/tunnckoCoreHQ/monarch/pull/127) [`d36be22`](https://github.com/tunnckoCoreHQ/monarch/commit/d36be22dedf62cf5450f2249c793991ccd9ca93a) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Show the Depot CI check, test, and build job badges in the README.

- [#132](https://github.com/tunnckoCoreHQ/monarch/pull/132) [`f32cf23`](https://github.com/tunnckoCoreHQ/monarch/commit/f32cf23fa820c2b2ed8337dc47f6b56416870816) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Add the license, Depot CI, and Socket Security badges to the README.

- [#65](https://github.com/tunnckoCoreHQ/monarch/pull/65) [`7e3532e`](https://github.com/tunnckoCoreHQ/monarch/commit/7e3532ee52d1ad66bc6f189e75b946d1b3da20e7) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Resolve workspace imports from source and use publishConfig.exports to keep published imports on built JavaScript and declarations.

- [#96](https://github.com/tunnckoCoreHQ/monarch/pull/96) [`2afd14d`](https://github.com/tunnckoCoreHQ/monarch/commit/2afd14d9464090af908d67aeb483610fe6026dee) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Relicense from FSL-1.1-ALv2 to Apache-2.0.

## 0.1.3

### Patch Changes

- db88810: Port the x402 router from wgw-deploy-cf into the monorepo.
