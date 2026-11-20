# @tunnckocore/ethscriptions-core

Functions for Ethscriptions. It fetches and filters ethscriptions, fetches user profiles, creates and checks SHA-256 digests, estimates ethscribing costs, and resolves ENS and Ethscriptions names.

It reads from the Ethscriptions API at `https://api.ethscriptions.com/v2` by default, or from another compatible API through the `baseURL` option. The `@tunnckocore/ethscriptions-server` package in this repository builds its API on it.

## Install

Add the scope to `.npmrc`, so only `@tunnckocore` packages resolve from there:

```
@tunnckocore:registry=https://npm.wgw.lol/
```

Then install it:

```bash
pnpm add @tunnckocore/ethscriptions-core
```

## Usage

Every function returns a promise of `{ ok: true, result, headers?, pagination? }` or `{ ok: false, error }`, and does not throw in most cases. The `headers` carry CDN cache headers for API responses. Every options object takes `baseURL` and custom `headers`.

```ts
import {
  checkExists,
  estimateDataCost,
  getAllEthscriptions,
  getDigestForData,
  getEthscriptionById,
  getEthscriptionDetailed,
  getUserProfile,
  resolveUser,
} from "@tunnckocore/ethscriptions-core";
import type { EthscriptionBase, Result } from "@tunnckocore/ethscriptions-core";

// Filters pass through to the upstream API. This lists the blobscriptions only.
const blobs = await getAllEthscriptions({ attachment_present: true });

// Pass `pagination.page_key` back to get the next page.
const images = await getAllEthscriptions({ media_type: "image" });
if (images.ok && images.pagination?.has_more) {
  await getAllEthscriptions({ media_type: "image", page_key: images.pagination.page_key });
}

// By ethscription number or transaction hash. `with` adds upstream fields, `only` keeps the
// named fields.
const punk: Result<EthscriptionBase> = await getEthscriptionById("14");
const detailed = await getEthscriptionById("1559", {
  with: "content_uri,current_owner",
  only: "transaction_hash,content_uri,creator,current_owner",
});

// The second argument picks the detail: "meta", "content", "owners", "numbers", "transfers",
// or "attachment", and their aliases.
const owners = await getEthscriptionDetailed("1559", "owners");
const blob = await getEthscriptionDetailed("6040646", "attachment");

// ENS names, off-chain ENS names, and Ethscriptions names.
const user = await resolveUser("wgw");
const profile = await getUserProfile("wgw");

const digest = await getDigestForData("data:,foobar");
const exists = await checkExists(digest.ok ? digest.result.sha : "");

// Uses the current gas prices from ethgastracker.com.
const cost = await estimateDataCost("data:,foobar", { speed: "fast" });
```

## License

Released under the MPL-2.0 License.
