# Mews

Pixel-perfect pastel Mews, generated and rendered entirely on-chain.

![A pastel Mew](./test/fixtures/Mews.svg)

A collection of 1,000 pixel cats on Base. Sitting, smiling, or loafing, each Mew is drawn from a small set of shapes and soft colors. Its artwork lives in the contracts and stays the same when it changes wallets.

[Download the preview gallery](./preview/cats-12.html) and open it in a browser to see 1,000 example cats. This is an art preview, not the final mint lineup.

## The cats

| Trait | Choices |
| --- | --- |
| Pose | Sitting, mirrored sitting, happy, loaf |
| Coat | 36 pastel colors |
| Background | 24 colors |
| Face dots | Selected from 24 accent colors |
| Collar | Selected independently from the same accent palette, or none |

Eyes and shadows are darker versions of the coat. Face dots contrast with the eyes, and collar dots lighten or darken to stay visible. Happy cats keep their longer nose and never wear collars.

Every trait starts from the collection's fixed genesis seed, the original minter's address, and the token ID. If that produces a cat already in the collection, the contract retries with a new hash until it finds an unused appearance. Every minted Mew has a distinct appearance, which stays fixed after minting.

## Mint

Mint through [OpenSea](https://opensea.io/collection/mewscats/overview).

| Detail | Setting |
| --- | --- |
| Network | Base |
| Collection | [0x41c11fc8169a3051BCab720c7f5e16BaE1Bd3db8](https://basescan.org/address/0x41c11fc8169a3051BCab720c7f5e16BaE1Bd3db8) |
| Renderer | [0xea012Da68Da3903D6FD081508239a6ECB4a51576](https://basescan.org/address/0xea012Da68Da3903D6FD081508239a6ECB4a51576) |
| Total supply | 1,000 |
| Public mint price | 0.00042 ETH, plus network gas |
| Public wallet limit | 10 mints |
| Creator allocation | 20 total, included in the supply |
| Secondary royalties | 5% |

All 20 creator tokens are minted at deployment: five to `0x9D9db340778139774cF73DFB7Bf27498Fa67978F` and fifteen to `0x6C22d03544609Db5128736706d90D66fC7f45388`. There is no private creator stage. Mint counts stay with the original wallet, so transferring cats does not reset a wallet's limit.

The [first deployment](https://basescan.org/address/0xdb01024fBb2a3A8d8037dA80BF99Ea82840d2f21) has its public mint closed. The collection above replaces it and reuses its renderer.

### Schedule

The configured public mint schedule is below. All dates are in 2026.

| Event | UTC | Eastern | Pacific |
| --- | --- | --- | --- |
| Public mint opens | Sep 8, 22:00 | Sep 8, 6 PM EDT | Sep 8, 3 PM PDT |
| Public mint closes | Sep 22, 22:00 | Sep 22, 6 PM EDT | Sep 22, 3 PM PDT |

The public mint lasts two weeks, unless the collection sells out first. These dates, the price, and the wallet limit are configured on SeaDrop. A new deployment leaves the public mint closed until its sale is configured.

## Make your own combinations

After 500 Mews have been minted, holders can use the collection's generator with a seed or hand-picked traits. It returns the cat's traits and colors without minting another NFT or using up collection supply.

The renderer is also public for anyone building with the art. The holder check applies to the collection's generation methods.

## For agents

Agents and people use the same public mint. No agent registration, allowlist, or browser wallet is needed for the public stage.

Call SeaDrop on Base with the deployed Mews collection address and send exactly `0.00042 ETH × quantity`:

```solidity
seaDrop.mintPublic{value: 0.00042 ether * quantity}(
    mewsAddress,
    0x0000a26b00c1F0DF003000390027140000fAa719,
    address(0),
    quantity
);
```

The SeaDrop address is `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`. The zero recipient argument mints to the calling wallet. SeaDrop checks the mint window, payment, supply, and wallet limit.

For an existing Mew, call `tokenURI(tokenId)` for its image and metadata, or `tokenData(tokenId)` for typed traits and colors that another contract can use. The holder methods are `generate(seed)` and `generate(traits)`; explicit traits use their visual hash as the returned seed.

## Ownership and royalties

The artwork, genesis seed, and supply cap are fixed. The collection owner can update the mint settings, collection profile, royalty rate, payout addresses, and transfer validator.

Transfers you send directly from your own wallet, including a smart wallet, are allowed. The deployed collection uses validator list 21, which preserves OpenSea's authorizer and allows the Seaport operator used by Net Bazaar. OpenSea reports 5% required creator earnings. The Seaport exception also permits other orders through that operator without royalty authorization, so royalties are not guaranteed across all marketplaces. Other marketplace and vault transfers must satisfy the validator's rules.

## Explore the source

The [renderer](./src/MewsRenderer.sol) draws the cats. [MewsArt](./src/MewsArt.sol) connects that renderer to NFT ownership and holder access. The [basic NFT](./src/Mews.sol) is a free-mint version for local development; the [SeaDrop NFT](./src/MewsSeaDrop.sol) is the launch contract.

<details>
<summary>Run the preview locally</summary>

From the monorepo root, with the workspace dependencies and Foundry installed:

```sh
vp run --filter mews preview
```

The command prints the path to a new gallery file. Open it in a browser. It also exports individual SVGs to `preview/rendered/`.

</details>

<details>
<summary>Deploy from an .env file</summary>

Copy `.env.example` to `.env` inside `solidity/mews` and set `PRIVATE_KEY` to the key for `0x6C22d03544609Db5128736706d90D66fC7f45388`. The file is ignored by Git. Forge loads it automatically; the script rejects a key for a different wallet.

From the monorepo root, simulate with the existing renderer address:

```sh
vp run --filter mews deploy --rpc-url https://mainnet.base.org \
  --sig "run(address)" 0xea012Da68Da3903D6FD081508239a6ECB4a51576
```

Add `--broadcast` to deploy. The [deployment script](./script/Deploy.s.sol) accepts an existing renderer as an argument, rejects an address without contract code, deploys the NFT, sets 5% royalties, and sets the transfer validator. It does not configure the sale or the custom validator list. No interactive prompt or command-line key is needed.

After deployment, connect the owner wallet to OpenSea Studio, open Mews, and configure the collection profile, public mint schedule, price, wallet limit, and payout address. Studio submits these settings through the owner-only `multiConfigure` method. It uses the upstream SeaDrop ABI and supports public drops, drop metadata, allowlists, payouts, fee recipients, and payers. Supply stays fixed at 1,000: a nonzero `maxSupply` must equal 1,000 and emits `MaxSupplyUpdated` for indexing. The constructor also emits this event, and the owner can emit it again with `setMaxSupply(1000)`. Base URI, provenance changes, token gating, and signed-mint settings are ignored.

The collection URI starts empty. Every `multiConfigure` call sets the hardcoded Mews collection metadata and ignores the supplied `contractURI` field. The owner can change it separately with `setContractURI`. Keep the planned 10% OpenSea mint fee and the same 5% creator earnings, enable earnings enforcement in Studio, then publish the mint page. Until the public drop is configured and its start time arrives, public minting is closed.

</details>

Code license: Apache-2.0.
