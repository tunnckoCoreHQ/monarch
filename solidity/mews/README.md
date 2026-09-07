# Mews

An ERC721A NFT with on-chain SVG and JSON generation for Mews pixel cats on Base.

There are 36 coat colors, 24 background colors, and 24 accent colors shared by face dots and collars. Face and collar colors are selected independently. Eyes darken the coat without changing its hue or chroma. Face dots are lighter than the eyes and use a hue at least 60 degrees apart. Collars sit eight lightness points below the coat. Their dots keep the collar hue and lighten or darken according to its lightness. Happy cats keep their longer nose and never wear collars. Each pose is centered within the square image.

The renderer is the shared core for seed derivation, traits, colors, SVG, and JSON. It exposes `generate(bytes32 seed)` and `generate(Traits selected)` for artwork outside the collection. Both return `TokenData`; explicitly selected traits use `visualHash(traits, colors)` as their seed.

Both NFT contracts inherit `MewsArt`, which holds the shared NFT state, renderer calls, and generation access checks. Its `generate` methods unlock after 500 NFTs have been minted and check the caller's current Mews balance. Generation writes no state and remains available after sellout. The renderer itself is public and has no access restrictions.

The basic `Mews` wrapper exposes free `mint(quantity)`. The `MewsSeaDrop` wrapper handles SeaDrop mint authorization and configuration, collection metadata, and royalties. Neither uses an agent registry. The SeaDrop NFT constructor mints token #1 to `0x9D9db340778139774cF73DFB7Bf27498Fa67978F` and token #2 to `0x6C22d03544609Db5128736706d90D66fC7f45388`. These internal mints need no SeaDrop configuration or open mint stage. Supply is capped at 1,000, including these two tokens.

The deployment script configures a free allowlist stage for the deployer, capped at 20, followed by a public stage at 0.00042 ETH and ten mints per wallet. The deployer, mint payout, and 5% royalty receiver are all `0x6C22d03544609Db5128736706d90D66fC7f45388`.

The NFT constructor creates the default `contractURI` as a Base64 JSON data URI with the collection name, symbol, description, and collaborators `0x9d9db340778139774cf73dfb7bf27498fa67978f` and `0x6c22d03544609db5128736706d90d66fc7f45388`. The owner can replace it through `setContractURI`, which emits `ContractURIUpdated()`. Collaborators describe editing access for supporting apps; they do not receive contract-owner permissions.

Forge handles signing: `--interactive` prompts for the private key locally, `--account <name>` selects a keystore, and `--private-key` is also supported. The script uses `vm.startBroadcast(DEPLOYER)`; sign with the wallet for the address above. It does not read or store private keys. Run `vp run --filter mews deploy --rpc-url https://mainnet.base.org --interactive` to simulate. Add `--broadcast` when ready to send the transactions.

The launch schedule defaults to the following dates. The creator stage ends at 21:59:59 UTC, immediately before the public stage opens. September 7 is U.S. Labor Day; the selected slot covers East Coast evening and West Coast afternoon.

| Event | UTC | U.S. Eastern (EDT) | U.S. Pacific (PDT) | Unix timestamp |
| --- | --- | --- | --- | --- |
| Creator mint opens | Mon Sep 7, 2026, 21:50 | Sep 7, 5:50 PM | Sep 7, 2:50 PM | 1788817800 |
| Public mint opens | Mon Sep 7, 2026, 22:00 | Sep 7, 6:00 PM | Sep 7, 3:00 PM | 1788818400 |
| Public mint closes | Mon Sep 21, 2026, 22:00 | Sep 21, 6:00 PM | Sep 21, 3:00 PM | 1790028000 |

The script accepts `PRIVATE_START_TIME`, `START_TIME`, and `END_TIME` overrides as Unix timestamps. The genesis seed is the Keccak-256 hash of the exact item description, `Pixel-perfect pastel Mews, generated and rendered entirely on-chain.`, encoded as UTF-8 without a trailing newline: `0x16d36060713ed435b1761b49f9dea722ca74036df09c258bf28975cddb5be2b7`.

There are 20 free tokens total, including the two constructor mints. The deployer can claim the remaining 18 through SeaDrop's `mintAllowList` during the creator stage, using the `creatorStage` parameters returned by the deployment script and an empty proof. The sole allowlist leaf binds those parameters to the deployer address. The stage supply ceiling is 20; all count toward the 1,000 total. After the full free allocation, the deployer holds 19 and the other collaborator holds one. SeaDrop's wallet limits count previous mints across stages, so the deployer cannot also mint in the ten-per-wallet public stage.

Agents and people use the same public mint: call `mintPublic(MEWS, OPENSEA_FEE_RECIPIENT, address(0), quantity)` on Base's SeaDrop at `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`, sending `0.00042 ether * quantity`. The configured fee recipient is `0x0000a26b00c1F0DF003000390027140000fAa719`. The zero recipient argument means mint to the caller. Public mint payments split 10% to OpenSea and 90% to the creator payout address.

Both use `keccak256(abi.encode(provenanceHash, keccak256(abi.encode(originalMinter)), tokenId))`. The original minter is recorded once per batch, with ERC721A's extra data keeping that association through transfers. Minting does not call the renderer or generate traits. Artwork is generated only on reads, without stored traits or retry loops.

On reads, the complete minter seed selects every trait: pose, coat, face dots, collar color, background, and whether the collar appears. Eyes, shadows, and collar dots follow the same color rules. Happy cats never wear collars. Different seeds can select the same visible traits; there is no duplicate prevention.

The SeaDrop address, supply, and provenance hash are fixed at deployment. `setProvenanceHash` always reverts. The owner can update the contract URI, public drop, allowlist, payout address, fee recipients, and royalty settings. There is no base URI.

The SeaDrop wrapper implements OpenSea's creator-token transfer validation. Deployment sets the Base validator at `0xA000027A9B2802E1ddf7000061001e5c005A0000`. Its default rules allow owner-initiated wallet transfers; other operators need authorization or inclusion in the validator's approved list. Minting skips transfer validation. The contract owner can update or disable the validator. After deployment, set the matching 5% creator earnings in OpenSea Studio and enable enforcement there so OpenSea issues the sale authorizations. The basic NFT remains independent of this validator.

The renderer exposes `generate(bytes32 seed)` for both collection artwork and standalone generation. Both NFT contracts expose `tokenData(uint256 tokenId)`. These return a `TokenData` struct containing the seed, typed traits, and resolved OKLCH colors. Lightness is a percentage, chroma is in thousandths, and hue is in degrees. The `hasCollar` field indicates whether collar colors are used.

Open [preview/cats-12.html](./preview/cats-12.html) for the full collection. The gallery embeds all 1,000 SVGs and displays 36 per page. Individual SVGs are also in [preview/rendered](./preview/rendered/). The original artwork is in [references](./references/).

The existing gallery is preserved from the earlier basic NFT. Running the preview script generates a new gallery using the current shared renderer and basic NFT. It mints the full supply and exports every NFT through `tokenURI`. Its genesis seed is a fixed demonstration value.

Run from the monorepo root:

```sh
vp run --filter mews check
vp run --filter mews preview
```

Each preview run prints a new HTML filename to avoid T3's cached previews.

SeaDrop tests run offline against the deployed Base bytecode from block 50,965,136, saved in `test/fixtures/SeaDrop.hex` and checked by its code hash. The basic NFT and its gallery remain separate from the SeaDrop contract.

Transfer tests use the Base validator bytecode from block 50,972,204, saved in `test/fixtures/TransferValidator.hex`, with a local authorization list. They cover direct wallet transfers, rejected operators, token-specific authorization, and minting with validation enabled.

License: Apache-2.0.
