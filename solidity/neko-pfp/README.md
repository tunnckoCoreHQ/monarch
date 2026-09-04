# neko-pfp

Fully on-chain generative 0xNeko SVG cat PFPs. Fixed supply 4663, deterministic reveal, and a burn-based fusion game where you merge duplicates and mutate cats into scarce high-mass ones. See [docs/MECHANICS.md](./docs/MECHANICS.md) for the game rules.

## Contracts

- `INekoGenerator`. Trait, token-data, and rendering interface.
- `NekoBase`. Errors, limits, keccak domains, trait math, and visible/matrix/invisible trait generation.
- `NekoRenderer`. SVG layers, metadata attributes, palette, toy lookup.
- `NekoGenerator`. Deployed generator. Trait derivation, validation, fusion combination, SVG and JSON rendering.
- `NekoPFP`. The NFT. Committed reveal, quota-aware deterministic seeds (keyed 13-bit Feistel plus rejection sampling), and the fusion game with on-chain ancestry.
- `seadrop/ERC721SeaDropCompat`. Abstract base that makes `NekoPFP` a valid `INonFungibleSeaDropToken` for OpenSea SeaDrop. Handles `mintSeaDrop`, `getMintStats`, ERC-2981 royalties, the allowed-SeaDrop list, and the eight owner passthroughs to the SeaDrop protocol.
- `seadrop/*` interfaces. Re-declared at this project's compiler. Selectors match the deployed protocol, so `type(INonFungibleSeaDropToken).interfaceId` is `0x1890fe8e`, the value SeaDrop checks before accepting any config call.

Dependencies are npm-only: `erc721a`, `solady`, and `viem` (allowlist tooling). No submodules, no vendored code. The SeaDrop protocol is not imported. It lives on-chain and gets called through the passthroughs.

## Build and test

Managed by Pnpm, VitePlus, and Foundry.

```
# from the monorepo root
vp run solidity:check             # all projects
vp run check                      # lints and formats package.json, markdowns and typescript files
vp run --filter neko-pfp check    # this project only

# from this folder
vp run check
```

Individual scripts: `fmt`, `lint`, `test`, `build`, `gas`, `snapshot`.

## The drop plan

SeaDrop lives at `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5` on every supported chain, including Robinhood Chain. Deploy costs for Ethereum mainnet and Robinhood Chain are in [docs/DEPLOY-COSTS.md](./docs/DEPLOY-COSTS.md).

Two phases. Allowlist first, public later.

|                         | free (stage 1) | public           |
| ----------------------- | -------------- | ---------------- |
| price                   | 0              | TBD              |
| lifetime cap per wallet | 3              | 10 (placeholder) |
| window                  | first          | separate, later  |
| who                     | allowlisted    | anyone           |

One leaf per allowlisted wallet: 3 free mints, claimable in one tx or several. SeaDrop caps are lifetime, not per stage, so the public cap includes the free mints: an allowlisted wallet that claimed all 3 can buy up to 7 more in public, everyone else up to 10.

Royalties are zero. The game is the product. Nothing to configure; the ERC-2981 default is `(address(0), 0)` and stays that way.

OpenSea takes 10% of primary mint proceeds (`feeBps = 1000` in every stage, `restrictFeeRecipients = true`, fee wallet `0x0000a26b00c1F0DF003000390027140000fAa719`, "OpenSea: Fees 3"). Free mints pay nothing, so the fee only touches the paid stages.

## Launch runbook

Decisions still open: chain, payout wallet, public price, the final public cap, both time windows. Everything below is ready to run once those are set.

### 1. Seed and commitment

Generate a random 32-byte seed. Keep it offline until reveal. Compute the commitment:

```
SEED=0x...                       # secret, 32 bytes
DOMAIN=$(cast keccak "NekoPFPSeaDrop.genesisSeedCommitment.v1")
COMMITMENT=$(cast keccak $(cast abi-encode "f(bytes32,bytes32)" $DOMAIN $SEED))
```

The commitment lands in the SeaDrop-standard `provenanceHash` slot and is sealed: `setProvenanceHash` reverts with `ProvenanceHashImmutable`.

### 2. Deploy

One script, four transactions: deploy `NekoGenerator`, deploy `NekoPFP` (constructor sets `maxSupply = 4663` and the commitment), set the payout address, allow OpenSea's fee wallet.

```
GENESIS_SEED_COMMITMENT=$COMMITMENT PAYOUT_ADDRESS=<payout> \
  forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $PK --broadcast
```

Cast equivalents for the two config calls, if ever needed standalone:

```
cast send $NEKO "updateCreatorPayoutAddress(address,address)" $SEADROP $PAYOUT
cast send $NEKO "updateAllowedFeeRecipient(address,address,bool)" $SEADROP 0x0000a26b00c1F0DF003000390027140000fAa719 true
```

### 3. Allowlist stage

Build the merkle tree (one leaf per wallet: 3 free mints), host the JSON, publish the root:

```
START_TIME=<unix> END_TIME=<unix> \
  node scripts/allowlist-merkle.ts wallets.txt > allowlist.json
# host allowlist.json somewhere stable (the proofs live there), then:
MERKLE_ROOT=<root> ALLOWLIST_URI=<uri> NEKO=<token> \
  forge script script/ConfigureDrop.s.sol --sig "allowlist()" --rpc-url $RPC_URL --private-key $PK --broadcast
```

Cast equivalent:

```
cast send $NEKO "updateAllowList(address,(bytes32,string[],string))" $SEADROP "($ROOT,[],\"$URI\")"
```

The leaf encoding (`keccak256(abi.encode(minter, mintParams))`, sorted-pair proofs) is pinned by `test/NekoAllowListLeaf.t.sol` against fixtures the TS script generated. If the script ever drifts from what SeaDrop verifies, that test fails.

### 4. Public stage

When the public window is decided:

```
PUBLIC_PRICE_WEI=<wei> START_TIME=<unix> END_TIME=<unix> NEKO=<token> \
  forge script script/ConfigureDrop.s.sol --sig "publicDrop()" --rpc-url $RPC_URL --private-key $PK --broadcast
```

Cast equivalent (cap 10, fee 1000 bps, restricted recipients):

```
cast send $NEKO "updatePublicDrop(address,(uint80,uint48,uint48,uint16,uint16,bool))" $SEADROP "($PRICE,$START,$END,10,1000,true)"
```

### 5. OpenSea mint page

Two things get called "the drop page". They are separate.

- `opensea.io/collection/<slug>/drop` is the per-collection mint page. Countdown, stage indicator, allow-list checker, mint button. Self-serve.
- `opensea.io/drops` is the editorial calendar of featured launches. Not self-serve.

Studio flow, per OpenSea's [Create a primary drop](https://docs.opensea.io/docs/create-a-drop) docs:

1. Sign in at [opensea.io/studio](https://opensea.io/studio) with the deployer wallet on the right chain. Studio calls `supportsInterface(0x1890fe8e)` and lists the contract. Discovery is by ownership; there is no import button because none is needed.
2. Fill in collection details. Name and description come from the on-chain `contractURI`; add banner, logo, socials.
3. Skip metadata upload. Studio's uploader is for off-chain `baseURI` collections. `NekoGenerator` returns full data URIs.
4. Check the drop settings show the stages configured in steps 3 and 4. Studio dispatches the same passthroughs, so on-chain config and Studio config are interchangeable.
5. Customize the landing page, then Publish. That signs an on-chain tx and turns on `opensea.io/collection/<slug>/drop`.

Without Studio, minting still works. Anyone can call `SeaDrop.mintPublic(nftContract, feeRecipient, minterIfNotPayer, quantity)` from a wallet or dapp, or use the OpenSea Drops SDK (`sdk.api.buildDropMintTransaction`). You lose the `/drop` UI, not the mint.

### 6. Reveal

Once all 4663 are minted:

```
cast send $NEKO "reveal(bytes32)" $SEED
```

The contract checks the preimage against `provenanceHash`, unlocks metadata for every token in one transaction with `BatchMetadataUpdate(1, type(uint256).max)`, and enables `merge` and `mutate`. OpenSea usually picks up the change on its own; if not, `cast send $NEKO "setBaseURI(string)" ""` emits another `BatchMetadataUpdate` and forces a refresh.

Also publish `allowlist.json` and (post-reveal) the seed itself, so anyone can re-derive the whole corpus offline with `deriveTokenSeed`.

## License

GPL-3.0-or-later
