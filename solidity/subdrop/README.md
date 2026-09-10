# subdrop

Mint-to-earn for wrapped ENS names. The owner of `apple1.eth` configures a token reward once. Anyone who mints `dan.apple1.eth` pays the price and receives the reward in the same transaction.

The parent owner keeps the name and the token treasury. Subdrop never holds either.

## Contracts

- `Subdrop` is a singleton registrar keyed by parent node. It mints subnames through the ENS NameWrapper, sets the address record to the minter, pulls the reward from the owner's allowance, and forwards the price to the fee recipient.
- `DropToken` is a fixed-supply ERC20 deployed as a clone by `Subdrop.launch`. It mints the supply to the caller and grants Subdrop an unlimited allowance, so a launch needs only the NameWrapper operator approval.

## Owner setup

1. Wrap the parent name and burn `CANNOT_UNWRAP` on it. NameWrapper only allows parent-controlled fuses on children after that.
2. Call `setApprovalForAll(subdrop, true)` on NameWrapper.
3. Either call `launch(parentNode, name, symbol, supply, config)` to deploy a new token, or approve an existing token for the reward budget and call `configure(parentNode, config)`.

The config holds the token, fee recipient, price, reward, child fuses, and an optional mint cap. `DEFAULT_FUSES` burns `PARENT_CANNOT_CONTROL | CANNOT_UNWRAP` so minters keep their subname until the parent expires.

## Minting

`mint(parentNode, label)` with `msg.value == price` gives the caller the subname with its address record set, plus `reward` tokens. `available(parentNode, label)` and `remaining(parentNode)` back the mint page. The remaining count is bounded by the cap and by the owner's token allowance and balance, so it stops at zero when the budget runs out.

Minting stops when the drop is paused, the cap is reached, the budget is empty, or the parent name changes hands.

## Build & Testing

Project is managed by Pnpm, VitePlus, and Foundry.

Unit tests run against mocks that mirror the NameWrapper rules. `test/SubdropFork.t.sol` runs the same flow against the real ENS contracts on a pinned mainnet block and skips unless an RPC URL is set:

```
MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com vp run test
```

From the root of the monorepo:

```
vp run --filter subdrop check
```

from this project's folder

```
vp run fmt
vp run lint
vp run test
vp run build

# or just
vp run check
```

## License

Apache-2.0
