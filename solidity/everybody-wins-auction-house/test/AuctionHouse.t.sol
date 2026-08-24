// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Test} from "forge-std/Test.sol";
import {AuctionHouse} from "../src/AuctionHouse.sol";
import {AuctionHouseFactory} from "../src/AuctionHouseFactory.sol";

contract MockCollection is ERC721 {
    constructor() ERC721("Mock Collection", "MOCK") {}

    function mint(address recipient, uint256 tokenId) external {
        _mint(recipient, tokenId);
    }
}

contract AuctionHouseTest is Test {
    uint40 internal constant DURATION = 1 days;
    uint96 internal constant STARTING_PRICE = 1 ether;

    address internal seller = makeAddr("seller");
    address internal secondSeller = makeAddr("secondSeller");
    address internal bidder = makeAddr("bidder");
    address internal nextBidder = makeAddr("nextBidder");
    address internal thirdBidder = makeAddr("thirdBidder");
    address internal fourthBidder = makeAddr("fourthBidder");
    address internal settler = makeAddr("settler");

    AuctionHouseFactory internal factory;
    AuctionHouse internal auctionHouse;
    MockCollection internal collection;

    function setUp() public {
        factory = new AuctionHouseFactory();
        collection = new MockCollection();

        collection.mint(seller, 1);
        collection.mint(seller, 2);
        collection.mint(secondSeller, 3);
        collection.mint(secondSeller, 4);

        vm.prank(seller);
        auctionHouse = AuctionHouse(factory.deployAuctionHouse(address(collection)));

        vm.deal(seller, 100 ether);
        vm.deal(secondSeller, 100 ether);
        vm.deal(bidder, 100 ether);
        vm.deal(nextBidder, 100 ether);
        vm.deal(thirdBidder, 100 ether);
        vm.deal(fourthBidder, 100 ether);
    }

    function test_FactoryDeploysOnePublicHouseForCollection() public view {
        assertEq(factory.auctionHouseFor(address(collection)), address(auctionHouse));
        assertEq(address(auctionHouse.collection()), address(collection));
        assertEq(auctionHouse.protocol(), address(factory));
    }

    function test_RevertWhen_FactoryDeploysSecondHouseForCollection() public {
        vm.expectRevert(AuctionHouseFactory.AuctionHouseAlreadyDeployed.selector);
        factory.deployAuctionHouse(address(collection));
    }

    function test_RevertWhen_FactoryGetsNonCollection() public {
        vm.expectRevert(AuctionHouseFactory.InvalidCollection.selector);
        factory.deployAuctionHouse(address(this));
    }

    function test_RevertWhen_NonHolderDeploysCollectionHouse() public {
        MockCollection otherCollection = new MockCollection();

        vm.expectRevert(AuctionHouseFactory.NotCollectionHolder.selector);
        factory.deployAuctionHouse(address(otherCollection));
    }

    function test_HoldersStartConcurrentAuctions() public {
        uint64 firstAuction = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        uint64 secondAuction = _startAuction(secondSeller, 3, 2 ether, DURATION);

        AuctionHouse.Auction memory first = auctionHouse.getAuction(firstAuction);
        AuctionHouse.Auction memory second = auctionHouse.getAuction(secondAuction);

        assertEq(first.seller, seller);
        assertEq(first.tokenId, 1);
        assertEq(second.seller, secondSeller);
        assertEq(second.tokenId, 3);
        assertEq(auctionHouse.totalAuctions(), 2);
        assertEq(collection.ownerOf(1), address(auctionHouse));
        assertEq(collection.ownerOf(3), address(auctionHouse));
    }

    function test_QuoteShowsBonusAndTotalPayment() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        _bid(bidder, auctionId, STARTING_PRICE, STARTING_PRICE);

        AuctionHouse.BidQuote memory quote =
            auctionHouse.quoteBid(auctionId, 1.06 ether, nextBidder);

        assertEq(quote.minimum, 1.06 ether);
        assertEq(quote.bonus, 0.0212 ether);
        assertEq(quote.totalCost, 1.0812 ether);
        assertEq(quote.creditUsed, 0);
        assertEq(quote.ethRequired, 1.0812 ether);
    }

    function test_OutbidBidderEarnsRefundAndBonus() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        _bid(bidder, auctionId, STARTING_PRICE, STARTING_PRICE);
        _bid(nextBidder, auctionId, 1.06 ether, 1.0812 ether);

        AuctionHouse.Auction memory auction = auctionHouse.getAuction(auctionId);
        assertEq(auction.highestBidder, nextBidder);
        assertEq(auction.highestBid, 1.06 ether);
        assertEq(auction.bidCount, 2);
        assertEq(auctionHouse.credits(bidder), 1.0212 ether);
    }

    function test_MinimumAlwaysKeepsSellerAheadOfPreviousBidder() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        _bid(bidder, auctionId, STARTING_PRICE, STARTING_PRICE);
        _bid(nextBidder, auctionId, 1.06 ether, 1.0812 ether);

        uint96 thirdBid = uint96(auctionHouse.minimumBid(auctionId));
        AuctionHouse.BidQuote memory thirdQuote =
            auctionHouse.quoteBid(auctionId, thirdBid, thirdBidder);
        _bid(thirdBidder, auctionId, thirdBid, thirdQuote.ethRequired);

        uint96 fourthBid = uint96(auctionHouse.minimumBid(auctionId));
        AuctionHouse.BidQuote memory quote =
            auctionHouse.quoteBid(auctionId, fourthBid, fourthBidder);
        _bid(fourthBidder, auctionId, fourthBid, quote.ethRequired);

        uint256 sellerProceeds = uint256(fourthBid) - ((uint256(fourthBid) * 4) / 100);
        sellerProceeds -= sellerProceeds / 100;
        uint256 previousPayout = uint256(thirdBid) + quote.bonus;
        assertGt(sellerProceeds, previousPayout);
    }

    function test_ReusesCreditAcrossAuctions() public {
        uint64 firstAuction = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        uint64 secondAuction = _startAuction(secondSeller, 3, 1.1 ether, DURATION);

        _bid(bidder, firstAuction, STARTING_PRICE, STARTING_PRICE);
        _bid(nextBidder, firstAuction, 1.06 ether, 1.0812 ether);

        AuctionHouse.BidQuote memory quote = auctionHouse.quoteBid(secondAuction, 1.1 ether, bidder);
        assertEq(quote.creditUsed, 1.0212 ether);
        assertEq(quote.ethRequired, 0.0788 ether);

        _bid(bidder, secondAuction, 1.1 ether, 0.0788 ether);

        assertEq(auctionHouse.credits(bidder), 0);
        assertEq(auctionHouse.getAuction(secondAuction).highestBidder, bidder);
    }

    function test_SettlementPaysSellerSettlerAndProtocol() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        _bid(bidder, auctionId, STARTING_PRICE, STARTING_PRICE);
        _bid(nextBidder, auctionId, 1.06 ether, 1.0812 ether);

        vm.warp(block.timestamp + DURATION);
        vm.prank(settler);
        auctionHouse.settle(auctionId);

        assertEq(collection.ownerOf(1), nextBidder);
        assertEq(auctionHouse.credits(bidder), 1.0212 ether);
        assertEq(auctionHouse.credits(seller), 1.028_412 ether);
        assertEq(auctionHouse.credits(settler), 0.010_388 ether);
        assertEq(address(factory).balance, 0.0212 ether);
        assertGt(auctionHouse.credits(seller), auctionHouse.credits(bidder));
        assertFalse(auctionHouse.canSettle(auctionId));

        vm.expectRevert(AuctionHouse.AuctionNotFound.selector);
        auctionHouse.getAuction(auctionId);
    }

    function test_NoBidSettlementReturnsTokenToSeller() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);

        vm.warp(block.timestamp + DURATION);
        auctionHouse.settle(auctionId);

        assertEq(collection.ownerOf(1), seller);
        assertEq(address(factory).balance, 0);
    }

    function test_WithdrawPaysCredit() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        _bid(bidder, auctionId, STARTING_PRICE, STARTING_PRICE);
        _bid(nextBidder, auctionId, 1.06 ether, 1.0812 ether);

        uint256 balanceBefore = bidder.balance;
        vm.prank(bidder);
        auctionHouse.withdraw();

        assertEq(bidder.balance, balanceBefore + 1.0212 ether);
        assertEq(auctionHouse.credits(bidder), 0);
    }

    function test_ProtocolWithdrawsFactoryFees() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        _bid(bidder, auctionId, STARTING_PRICE, STARTING_PRICE);

        vm.warp(block.timestamp + DURATION);
        auctionHouse.settle(auctionId);

        uint256 balanceBefore = address(this).balance;
        factory.withdrawProtocolFees(0);

        assertEq(address(this).balance, balanceBefore + 0.01 ether);
        assertEq(address(factory).balance, 0);
    }

    function test_RevertWhen_NonOwnerWithdrawsProtocolFees() public {
        vm.prank(bidder);
        vm.expectRevert(AuctionHouseFactory.Unauthorized.selector);
        factory.withdrawProtocolFees(0);
    }

    function test_RevertWhen_SellerBids() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);

        vm.prank(seller);
        vm.expectRevert(AuctionHouse.SellerCannotBid.selector);
        auctionHouse.bid{value: STARTING_PRICE}(auctionId, STARTING_PRICE);
    }

    function test_RevertWhen_HighestBidderBidsAgain() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        _bid(bidder, auctionId, STARTING_PRICE, STARTING_PRICE);

        vm.prank(bidder);
        vm.expectRevert(AuctionHouse.AlreadyHighestBidder.selector);
        auctionHouse.bid{value: 1.06 ether}(auctionId, 1.06 ether);
    }

    function test_RevertWhen_BidIsBelowMinimum() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);

        vm.prank(bidder);
        vm.expectRevert(
            abi.encodeWithSelector(
                AuctionHouse.AuctionBidTooLow.selector, STARTING_PRICE - 1, STARTING_PRICE
            )
        );
        auctionHouse.bid{value: STARTING_PRICE - 1}(auctionId, STARTING_PRICE - 1);
    }

    function test_RevertWhen_PaymentDoesNotMatchQuote() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        _bid(bidder, auctionId, STARTING_PRICE, STARTING_PRICE);

        vm.prank(nextBidder);
        vm.expectRevert(
            abi.encodeWithSelector(AuctionHouse.IncorrectPayment.selector, 1.06 ether, 1.0812 ether)
        );
        auctionHouse.bid{value: 1.06 ether}(auctionId, 1.06 ether);
    }

    function test_RevertWhen_BiddingAfterEnd() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        vm.warp(block.timestamp + DURATION);

        vm.prank(bidder);
        vm.expectRevert(AuctionHouse.AuctionEnded.selector);
        auctionHouse.bid{value: STARTING_PRICE}(auctionId, STARTING_PRICE);
    }

    function test_RevertWhen_SettlingBeforeEnd() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);

        vm.expectRevert(AuctionHouse.AuctionNotEnded.selector);
        auctionHouse.settle(auctionId);
    }

    function test_RevertWhen_DurationIsZero() public {
        vm.startPrank(seller);
        collection.approve(address(auctionHouse), 1);
        vm.expectRevert(AuctionHouse.InvalidDuration.selector);
        auctionHouse.startAuction(1, STARTING_PRICE, 0);
        vm.stopPrank();
    }

    function _startAuction(address tokenOwner, uint256 tokenId, uint96 price, uint40 duration)
        internal
        returns (uint64 auctionId)
    {
        vm.startPrank(tokenOwner);
        collection.approve(address(auctionHouse), tokenId);
        auctionId = auctionHouse.startAuction(tokenId, price, duration);
        vm.stopPrank();
    }

    function _bid(address account, uint64 auctionId, uint96 amount, uint256 payment) internal {
        vm.prank(account);
        auctionHouse.bid{value: payment}(auctionId, amount);
    }

    receive() external payable {}
}
