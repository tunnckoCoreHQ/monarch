# @tunnckocore/ethscriptions-server

## 0.14.0

### Minor Changes

- [#167](https://github.com/tunnckoCoreHQ/monarch/pull/167) [`4d71af9`](https://github.com/tunnckoCoreHQ/monarch/commit/4d71af9bc39efbd0fb9e0a4fd1cb5e66b245017e) Thanks [@tunnckoCore](https://github.com/tunnckoCore)! - Move the Ethscriptions API server into monarch as `@tunnckocore/ethscriptions-server`. The home page takes a title, the build and source links point to monarch, and the build commit comes from `COMMIT_SHA`.

### Patch Changes

- [#170](https://github.com/tunnckoCoreHQ/monarch/pull/170) [`9f6e10c`](https://github.com/tunnckoCoreHQ/monarch/commit/9f6e10cba421d6bc518608f58f4f13b93e3157ee) Thanks [@olstenlarck](https://github.com/olstenlarck)! - Use `@tunnckocore/ethscriptions-core` instead of the `ethscriptions` package. The `/estimate` options are now snake_case (`eth_price`, `gas_price`, `base_fee`, `priority_fee`, `buffer_fee`), and a `baseURL` query param on the list routes replaces the upstream for that request.
- Updated dependencies [[`9f6e10c`](https://github.com/tunnckoCoreHQ/monarch/commit/9f6e10cba421d6bc518608f58f4f13b93e3157ee)]:
  - @tunnckocore/ethscriptions-core@0.12.0
