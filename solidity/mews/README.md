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

**Pending deployment.** The collection address and OpenSea mint link are not available yet.

| Detail | Setting |
| --- | --- |
| Network | Base |
| Total supply | 1,000 |
| Public mint price | 0.00042 ETH, plus network gas |
| Public wallet limit | 10 mints |
| Creator allocation | 20 total, included in the supply |
| Secondary royalties | 5% |

Two creator tokens are minted at deployment, one to each collaborator. The remaining 18 can be claimed during the private creator window. Mint counts stay with the original wallet, so transferring cats does not reset a wallet's limit.

### Schedule

All dates are in 2026. These are the configured launch times.

| Event | UTC | Eastern | Pacific |
| --- | --- | --- | --- |
| Creator mint opens | Sep 7, 21:50 | Sep 7, 5:50 PM EDT | Sep 7, 2:50 PM PDT |
| Public mint opens | Sep 7, 22:00 | Sep 7, 6 PM EDT | Sep 7, 3 PM PDT |
| Public mint closes | Sep 21, 22:00 | Sep 21, 6 PM EDT | Sep 21, 3 PM PDT |

The creator window lasts ten minutes. Public minting lasts two weeks, unless the collection sells out first.

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

The launch configuration supports royalty enforcement on OpenSea. Transfers you send directly from your own wallet are allowed. Marketplace and vault transfers must satisfy the validator's rules, so other integrations may need to be approved. OpenSea enforcement is activated during launch setup.

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

From the monorepo root, simulate with:

```sh
vp run --filter mews deploy --rpc-url https://mainnet.base.org
```

Add `--broadcast` to deploy. The [deployment script](./script/Deploy.s.sol) contains the launch settings. No interactive prompt or command-line key is needed.

</details>

Code license: Apache-2.0.
