# Everybody wins auction house

An ETH auction protocol for existing [ERC-721](https://eips.ethereum.org/EIPS/eip-721) NFTs. A new bidder pays a bonus to the person they outbid. The seller receives the sale proceeds, the final bidder receives the NFT, and anyone can earn a reward for settling the auction.

## How it works

1. **Create the collection's auction house.** Any holder can ask the factory to create one. Each collection gets one shared house, where its holders can run separate auctions. Creating that house does not give the holder control over other auctions or protocol fees.

2. **List an NFT.** Its owner approves the house, chooses a starting price and duration, and starts an auction. The house takes custody of the NFT until settlement.

3. **Bid and reward the previous bidder.** The first bid has no bonus. The second bidder pays their bid plus 2%, the third pays their bid plus 3%, and so on, capped at 10%. The previous bidder receives their bid amount plus the incoming bonus as withdrawable credit. Credit can also fund bids in other auctions within the same house. The `maxTotalCost` argument limits the combined ETH and credit spent.

4. **Settle after the deadline.** Anyone can settle. The winner gets the NFT. The protocol takes 1% per accepted bid, capped at 10%, from the winning bid. The settler receives 1% of what remains, and the seller receives the rest as credit. With no bids, the NFT returns to its seller.

The minimum bid increases with participation. Its ordinary increment starts at 6%, then 7%, then 8%. A second calculation can raise it further so that the seller's proceeds, after fees and the settler reward, exceed the previous bidder's refund plus bonus.

## Example

Alice bids **1 ETH**. Bob outbids her at **1.06 ETH**, paying **1.0812 ETH** including the bonus. If bidding ends there:

| Recipient |            Receives |
| --------- | ------------------: |
| Alice     |   1.0212 ETH credit |
| Seller    | 1.028412 ETH credit |
| Settler   | 0.010388 ETH credit |
| Protocol  |          0.0212 ETH |
| Bob       |             The NFT |

## Auction rules

The seller and current highest bidder cannot bid. Deadlines do not extend when someone bids. Contract winners must manage NFT custody themselves.

"Everybody wins" describes the intended distribution. Outbid refunds cover prior bid costs before gas, but tiny bids can earn zero bonus because of rounding. The final winner pays for the NFT.

## Build and test

Run the project checks from the monorepo root:

```shell
vp run --filter everybody-wins-auction-house check
```

## License

GPL-3.0-or-later
