# Everybody wins auction house

An ETH auction protocol for existing [ERC-721](https://eips.ethereum.org/EIPS/eip-721) NFTs. A new bidder pays a bonus to the person they outbid. The seller receives the sale proceeds, the final bidder receives the NFT, and anyone can earn a reward for settling the auction.

## How it works

1. **Create the collection's auction house.** Any holder can ask the factory to create one. Each collection gets one shared house, where its holders can run separate auctions. Creating that house does not give the holder control over other auctions or protocol fees.

2. **List an NFT.** Its owner approves the house, chooses a starting price of at least 0.001 ETH and a duration, and starts an auction. The house takes custody of the NFT until settlement or cancellation.

3. **Bid and reward the previous bidder.** The bid shown to the buyer should include the bonus. Internally, the contract calculates the total from `bidAmount` plus a bonus. The first bid has no bonus. The second bid adds 2% of `bidAmount`, the third adds 3%, and so on, capped at 10%. The previous bidder receives their `bidAmount` plus the incoming bonus as withdrawable credit. Credit can also fund bids in other auctions within the same house. The `maxTotalCost` argument limits the combined ETH and credit spent.

4. **Settle after the deadline.** Anyone can settle. The winner gets the NFT. The protocol takes 1% per accepted bid, capped at 10%, from the winning `bidAmount`. The settler receives 1% of what remains, and the seller receives the rest as credit. With no bids, the NFT returns to its seller.

The minimum `bidAmount` increases with participation. Its ordinary increment starts at 6%, then 7%, then 8%. A second calculation can raise it further so that the seller's proceeds, after fees and the settler reward, exceed the previous bidder's refund plus bonus.

## Example

Alice bids **1 ETH**. Bob outbids her with a total bid of **1.0812 ETH**, consisting of **1.06 ETH** in `bidAmount` and a **0.0212 ETH** bonus. If bidding ends there:

| Recipient |            Receives |
| --------- | ------------------: |
| Alice     |   1.0212 ETH credit |
| Seller    | 1.028412 ETH credit |
| Settler   | 0.010388 ETH credit |
| Protocol  |          0.0212 ETH |
| Bob       |             The NFT |

## Auction rules

The seller and current highest bidder cannot bid. Deadlines do not extend when someone bids. Contract winners must manage NFT custody themselves.

The seller can call `cancelAuction(auctionId)` before any bid has been accepted, including after the deadline. Cancellation returns the NFT to the seller and removes the auction. After an accepted bid, the auction must reach its deadline and settle.

The protocol-wide `MIN_STARTING_PRICE` is fixed at 0.001 ETH. Every house enforces it before taking custody of an NFT.

"Everybody wins" describes the intended distribution. Outbid refunds cover prior bid costs before gas. The final winner pays for the NFT.

## FAQ

### What amount should the UI call the bid?

The full amount the buyer spends, including the bonus. The contract's `bidAmount` is one component of that total. The UI should show `quoteBid(...).totalCost` as the bid and show the bonus, credit used, and ETH payment as its breakdown. Credit reduces the new ETH payment, not the total cost. The caller can pass the quoted total as `maxTotalCost` to limit spending if the quote becomes stale.

### How is an 11 ETH total bid split at the capped rates?

The total consists of 10 ETH in `bidAmount` and a 1 ETH bonus for the previous bidder. The protocol receives 1 ETH from `bidAmount`. The settler receives 1% of the remaining 9 ETH, or 0.09 ETH. The seller receives 8.91 ETH. The previous bidder also gets their earlier `bidAmount` back from the funds already held by the house.

The bonus and fees are part of the intended distribution. Showing the total and its components clearly is a UI concern; the payment math remains the same.

### What happens when nobody wants to bid higher?

The auction waits for its deadline and can then be settled. If it has an accepted bid, the highest bidder wins and pays, and earlier bidders keep their refund credits. If it has no accepted bids, the NFT returns to the seller. A price above further demand does not invalidate the auction or refund the highest bidder. Percentages can be tuned later without changing these settlement rules.

### Does the protocol prevent one person from bidding through several wallets?

No. The protocol does not identify the people behind wallets. The seller and current-highest-bidder restrictions apply to addresses. Using other addresses does not bypass minimum bids, payment rules, or settlement. If one of those addresses remains the highest bidder, it wins and pays. Identity enforcement is outside the protocol's scope.

### Is the auction resistant to front-running?

No. Bids are public, and transaction ordering can affect who bids first and who receives a bonus. The `maxTotalCost` argument limits the buyer's spending; it does not guarantee transaction order or a particular bonus recipient. Front-running resistance is a separate possible improvement. The current protocol does not use a commit-reveal bidding scheme.

### Do late bids extend the deadline?

No. The deadline is fixed when the auction starts. A response window after late bids is an eventual feature to consider, not current behavior.

## Build and test

Run the project checks from the monorepo root:

```shell
vp run --filter everybody-wins-auction-house check
```

## License

GPL-3.0-or-later
