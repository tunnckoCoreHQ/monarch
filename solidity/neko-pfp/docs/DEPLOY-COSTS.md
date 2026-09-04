# Deploy costs: Ethereum mainnet vs Robinhood Chain

Measured 2026-08-25. Gas comes from a fork simulation of `script/Deploy.s.sol` against mainnet (`forge script`, wallet-style estimates with the safety buffer included). Prices are spot: ETH $2,483.84 (CoinGecko API), gas prices read live with `cast gas-price` from `ethereum-rpc.publicnode.com` and `rpc.mainnet.chain.robinhood.com`. Recompute before launch; all four numbers move.

## Gas per transaction

| #   | Transaction                  | Gas (est)      |
| --- | ---------------------------- | -------------- |
| 1   | deploy `NekoGenerator`       | 6,442,464      |
| 2   | deploy `NekoPFP`             | 8,325,343      |
| 3   | `updateCreatorPayoutAddress` | 79,587         |
| 4   | `updateAllowedFeeRecipient`  | 138,024        |
|     | **deploy total**             | **14,985,418** |
| 5   | `updateAllowList` (later)    | ~100,000       |
| 6   | `updatePublicDrop` (later)   | ~100,000       |
| 7   | `reveal` (after mint-out)    | ~100,000       |

The two deploys are 98% of the total. The generator carries ~22.7kB of runtime code (SVG palettes, matrix background, toys); the NFT carries ~20.6kB plus a constructor that renders the full unrevealed image on-chain into `contractURI`.

## Ethereum mainnet (chain id 1)

Gas price at measurement: 0.26 gwei (`cast gas-price`); the fork simulation priced at 0.57 gwei.

| Gas price            | Deploy total (ETH) | Deploy total (USD) |
| -------------------- | ------------------ | ------------------ |
| 0.05 gwei            | 0.000749           | $1.86              |
| 0.10 gwei            | 0.001499           | $3.72              |
| 0.15 gwei            | 0.002248           | $5.58              |
| 0.26 gwei (measured) | 0.00392            | $9.74              |
| 0.57 gwei            | 0.00848            | $21.05             |
| 2 gwei (busy day)    | 0.02997            | $74.44             |

The three later txs (allowlist, public drop, reveal) add ~300k gas: under $0.20 at 0.26 gwei, ~$1.50 at 2 gwei.

## Mint cost on mainnet

Minting is light. The heavy machinery (seed sampling, trait derivation, SVG rendering) sits behind `tokenURI` and the other view functions, which cost nothing to call off-chain. A mint is a standard SeaDrop `mintPublic`: config reads, payment split, and an ERC721A batch mint.

Measured against the real deployed SeaDrop on a mainnet fork (`script/MintGasProbe.s.sol`):

| Mint                  | Execution gas | ~Tx gas | @0.05 gwei | @0.10 gwei | @0.15 gwei | @1 gwei |
| --------------------- | ------------- | ------- | ---------- | ---------- | ---------- | ------- |
| qty 1, wallet's first | 134,436       | ~156k   | $0.02      | $0.04      | $0.06      | $0.39   |
| qty 1, repeat         | 58,636        | ~100k   | $0.01      | $0.02      | $0.04      | $0.25   |
| qty 5, one tx         | 66,344        | ~105k   | $0.01      | $0.03      | $0.04      | $0.26   |

Tx gas adds the 21k intrinsic cost plus warm-up of accounts the probe had already touched; treat the tx column as the wallet-quote ballpark. ERC721A batching means five cats cost barely more than one. At 2026 mainnet gas levels the mint fee is cents; the mint price itself is the only number a minter feels.

## Robinhood Chain mainnet (chain id 4663)

The chain id equals the collection supply. Not a coincidence: 4663 was picked as the supply with this chain id in mind. Verified against chainid.network.

Gas token is ETH. Gas price at measurement: 0.0225 gwei. SeaDrop is deployed at the canonical address `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5` (verified with `cast code`, same bytecode as mainnet).

| Gas price   | Deploy total (ETH) | Deploy total (USD) |
| ----------- | ------------------ | ------------------ |
| 0.0225 gwei | 0.000337           | $0.84              |

Later txs: fractions of a cent.

Two caveats:

- Robinhood Chain is an Arbitrum Orbit rollup, so every tx also pays a small L1 data-posting fee on top of the execution gas above. For a one-time 15M-gas deploy this adds cents, not dollars.
- SeaDrop being deployed there makes the contracts work. Whether OpenSea Studio offers Robinhood Chain in its drop UI is a separate product question; confirm in Studio before committing to the chain.

## Reproduce

```
# gas: fork-simulate the deploy (no broadcast)
GENESIS_SEED_COMMITMENT=0x11..11 PAYOUT_ADDRESS=0xdead..beef \
  forge script script/Deploy.s.sol --rpc-url https://ethereum-rpc.publicnode.com

# per-tx gas
cat broadcast/Deploy.s.sol/1/dry-run/run-latest.json

# mint gas: probe the real SeaDrop on a mainnet fork
forge script script/MintGasProbe.s.sol --rpc-url https://ethereum-rpc.publicnode.com

# prices
cast gas-price --rpc-url https://ethereum-rpc.publicnode.com
cast gas-price --rpc-url https://rpc.mainnet.chain.robinhood.com
curl -s "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
```
