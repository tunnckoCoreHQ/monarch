// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Test} from "forge-std/Test.sol";
import {AuctionHouse} from "../src/AuctionHouse.sol";
import {AuctionHouseFactory} from "../src/AuctionHouseFactory.sol";

contract MockCollection is ERC721 {
    constructor() ERC721("Mock Collection", "MOCK") {}

    function mint(address recipient, uint256 tokenId) external {
        _mint(recipient, tokenId);
    }
}

contract RejectingNFTReceiver {
    error NFTRejected();

    function bid(AuctionHouse house, uint64 auctionId, uint96 amount) external payable {
        house.bid{value: msg.value}(auctionId, amount, msg.value);
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert NFTRejected();
    }

    function transferToken(ERC721 collection, address recipient, uint256 tokenId) external {
        collection.transferFrom(address(this), recipient, tokenId);
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
    bool internal rotateOwnerOnReceive;
    bool internal rejectETH;
    bool internal reenterWithdrawal;

    error ETHRejected();

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

    function test_StartAtMinimumPrice() public {
        uint96 minimum = auctionHouse.MIN_STARTING_PRICE();
        assertEq(minimum, 0.001 ether);
        uint64 auctionId = _startAuction(seller, 1, minimum, DURATION);

        assertEq(auctionHouse.minimumBid(auctionId), minimum);
        _bid(bidder, auctionId, minimum, minimum);
        assertEq(auctionHouse.getAuction(auctionId).highestBid, minimum);
    }

    function test_RevertWhen_StartingPriceBelowMinimum() public {
        uint96 minimum = auctionHouse.MIN_STARTING_PRICE();
        vm.startPrank(seller);
        collection.approve(address(auctionHouse), 1);

        vm.expectRevert(
            abi.encodeWithSelector(AuctionHouse.StartingPriceTooLow.selector, 0, minimum)
        );
        auctionHouse.startAuction(1, 0, DURATION);
        vm.expectRevert(
            abi.encodeWithSelector(AuctionHouse.StartingPriceTooLow.selector, minimum - 1, minimum)
        );
        auctionHouse.startAuction(1, minimum - 1, DURATION);
        vm.stopPrank();

        assertEq(collection.ownerOf(1), seller);
        assertEq(auctionHouse.totalAuctions(), 0);
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

    function test_CancelReturnsTokenAndAllowsRelisting() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);

        vm.prank(seller);
        vm.expectEmit(true, true, true, true, address(auctionHouse));
        emit AuctionHouse.AuctionCancelled(auctionId, 1, seller);
        auctionHouse.cancelAuction(auctionId);

        assertEq(collection.ownerOf(1), seller);
        assertFalse(auctionHouse.canSettle(auctionId));
        assertEq(auctionHouse.credits(seller), 0);
        assertEq(address(factory).balance, 0);
        vm.expectRevert(AuctionHouse.AuctionNotFound.selector);
        auctionHouse.getAuction(auctionId);
        vm.expectRevert(AuctionHouse.AuctionNotFound.selector);
        auctionHouse.cancelAuction(auctionId);
        vm.expectRevert(AuctionHouse.AuctionNotFound.selector);
        auctionHouse.settle(auctionId);
        vm.prank(bidder);
        vm.expectRevert(AuctionHouse.AuctionNotFound.selector);
        auctionHouse.bid{value: STARTING_PRICE}(auctionId, STARTING_PRICE, STARTING_PRICE);

        uint64 nextAuctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        assertEq(nextAuctionId, auctionId + 1);
        _bid(bidder, nextAuctionId, STARTING_PRICE, STARTING_PRICE);
        assertEq(auctionHouse.getAuction(nextAuctionId).highestBidder, bidder);
    }

    function test_CancelAfterDeadlineWithoutBids() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        vm.warp(block.timestamp + DURATION);

        vm.prank(seller);
        auctionHouse.cancelAuction(auctionId);

        assertEq(collection.ownerOf(1), seller);
        assertFalse(auctionHouse.canSettle(auctionId));
    }

    function test_RevertWhen_NonSellerCancels() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);

        vm.prank(bidder);
        vm.expectRevert(AuctionHouse.Unauthorized.selector);
        auctionHouse.cancelAuction(auctionId);

        assertEq(collection.ownerOf(1), address(auctionHouse));
        assertEq(auctionHouse.getAuction(auctionId).seller, seller);
    }

    function test_RevertWhen_CancellingAfterAcceptedBid() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        _bid(bidder, auctionId, STARTING_PRICE, STARTING_PRICE);

        vm.prank(seller);
        vm.expectRevert(AuctionHouse.AuctionHasBids.selector);
        auctionHouse.cancelAuction(auctionId);

        vm.warp(block.timestamp + DURATION);
        vm.prank(seller);
        vm.expectRevert(AuctionHouse.AuctionHasBids.selector);
        auctionHouse.cancelAuction(auctionId);

        assertEq(collection.ownerOf(1), address(auctionHouse));
        assertEq(auctionHouse.getAuction(auctionId).highestBidder, bidder);
        assertEq(address(auctionHouse).balance, STARTING_PRICE);
        auctionHouse.settle(auctionId);
        assertEq(collection.ownerOf(1), bidder);
    }

    function test_RejectedBidDoesNotBlockCancellation() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);

        vm.prank(bidder);
        vm.expectRevert(
            abi.encodeWithSelector(AuctionHouse.IncorrectPayment.selector, 0, STARTING_PRICE)
        );
        auctionHouse.bid(auctionId, STARTING_PRICE, STARTING_PRICE);

        vm.prank(seller);
        auctionHouse.cancelAuction(auctionId);
        assertEq(collection.ownerOf(1), seller);
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
        auctionHouse.bid{value: STARTING_PRICE}(auctionId, STARTING_PRICE, STARTING_PRICE);
    }

    function test_RevertWhen_HighestBidderBidsAgain() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        _bid(bidder, auctionId, STARTING_PRICE, STARTING_PRICE);

        vm.prank(bidder);
        vm.expectRevert(AuctionHouse.AlreadyHighestBidder.selector);
        auctionHouse.bid{value: 1.06 ether}(auctionId, 1.06 ether, 1.0812 ether);
    }

    function test_RevertWhen_BidIsBelowMinimum() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);

        vm.prank(bidder);
        vm.expectRevert(
            abi.encodeWithSelector(
                AuctionHouse.AuctionBidTooLow.selector, STARTING_PRICE - 1, STARTING_PRICE
            )
        );
        auctionHouse.bid{value: STARTING_PRICE - 1}(auctionId, STARTING_PRICE - 1, STARTING_PRICE);
    }

    function test_RevertWhen_PaymentDoesNotMatchQuote() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        _bid(bidder, auctionId, STARTING_PRICE, STARTING_PRICE);

        vm.prank(nextBidder);
        vm.expectRevert(
            abi.encodeWithSelector(AuctionHouse.IncorrectPayment.selector, 1.06 ether, 1.0812 ether)
        );
        auctionHouse.bid{value: 1.06 ether}(auctionId, 1.06 ether, 1.0812 ether);
    }

    function test_RevertWhen_BiddingAfterEnd() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        vm.warp(block.timestamp + DURATION);

        vm.prank(bidder);
        vm.expectRevert(AuctionHouse.AuctionEnded.selector);
        auctionHouse.bid{value: STARTING_PRICE}(auctionId, STARTING_PRICE, STARTING_PRICE);
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

    function test_WithdrawalEventKeepsActualRecipientWhenOwnerChangesInCallback() public {
        vm.deal(address(factory), 1 ether);
        uint256 balanceBefore = address(this).balance;
        rotateOwnerOnReceive = true;

        vm.expectEmit(true, false, false, true, address(factory));
        emit AuctionHouseFactory.ProtocolFeesWithdrawn(address(this), 1 ether);
        factory.withdrawProtocolFees(0);

        assertEq(factory.owner(), seller);
        assertEq(address(this).balance, balanceBefore + 1 ether);
        assertEq(address(factory).balance, 0);
    }

    function test_RejectingWinnerCannotBlockSettlement() public {
        RejectingNFTReceiver winner = new RejectingNFTReceiver();
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        winner.bid{value: STARTING_PRICE}(auctionHouse, auctionId, STARTING_PRICE);
        vm.warp(block.timestamp + DURATION);

        vm.prank(address(auctionHouse));
        vm.expectRevert(RejectingNFTReceiver.NFTRejected.selector);
        collection.safeTransferFrom(address(auctionHouse), address(winner), 1);
        assertEq(collection.ownerOf(1), address(auctionHouse));

        vm.prank(settler);
        auctionHouse.settle(auctionId);

        assertEq(collection.ownerOf(1), address(winner));
        assertEq(auctionHouse.credits(seller), 0.9801 ether);
        assertEq(auctionHouse.credits(settler), 0.0099 ether);
        assertEq(address(factory).balance, 0.01 ether);
        winner.transferToken(collection, thirdBidder, 1);
        assertEq(collection.ownerOf(1), thirdBidder);
    }

    function test_FailedWithdrawalPreservesCreditAndAllowsRetry() public {
        uint64 auctionId = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        vm.deal(address(this), 2 ether);
        _bid(address(this), auctionId, STARTING_PRICE, STARTING_PRICE);
        _bid(nextBidder, auctionId, 1.06 ether, 1.0812 ether);
        uint256 houseBalance = address(auctionHouse).balance;

        rejectETH = true;
        vm.expectRevert(AuctionHouse.TransferETHFailed.selector);
        auctionHouse.withdraw();
        assertEq(auctionHouse.credits(address(this)), 1.0212 ether);
        assertEq(address(auctionHouse).balance, houseBalance);

        rejectETH = false;
        reenterWithdrawal = true;
        uint256 balanceBefore = address(this).balance;
        auctionHouse.withdraw();
        assertEq(auctionHouse.credits(address(this)), 0);
        assertEq(address(this).balance, balanceBefore + 1.0212 ether);
    }

    function test_ImplementationAndHouseCannotBeReinitialized() public {
        AuctionHouse implementation = AuctionHouse(factory.implementation());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        implementation.initialize(address(collection));

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        auctionHouse.initialize(address(collection));
    }

    function test_CreditFundedBidKeepsUnusedCredit() public {
        uint64 firstAuction = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        uint64 secondAuction = _startAuction(secondSeller, 3, 0.5 ether, DURATION);
        _bid(bidder, firstAuction, STARTING_PRICE, STARTING_PRICE);
        _bid(nextBidder, firstAuction, 1.06 ether, 1.0812 ether);

        AuctionHouse.BidQuote memory quote = auctionHouse.quoteBid(secondAuction, 0.5 ether, bidder);
        assertEq(quote.creditUsed, 0.5 ether);
        assertEq(quote.ethRequired, 0);
        uint256 balanceBefore = address(auctionHouse).balance;
        _bid(bidder, secondAuction, 0.5 ether, 0);

        assertEq(auctionHouse.credits(bidder), 0.5212 ether);
        assertEq(address(auctionHouse).balance, balanceBefore);
        assertEq(auctionHouse.getAuction(secondAuction).highestBid, 0.5 ether);
    }

    function test_StaleCreditQuoteCannotSpendAboveLimit() public {
        uint64 firstAuction = _startAuction(seller, 1, STARTING_PRICE, DURATION);
        uint64 secondAuction = _startAuction(secondSeller, 3, 0.1 ether, DURATION);
        _bid(bidder, firstAuction, STARTING_PRICE, STARTING_PRICE);
        _bid(nextBidder, firstAuction, 1.06 ether, 1.0812 ether);
        _bid(nextBidder, secondAuction, 0.1 ether, 0.1 ether);

        AuctionHouse.BidQuote memory quote = auctionHouse.quoteBid(secondAuction, 0.5 ether, bidder);
        assertEq(quote.totalCost, 0.51 ether);
        assertEq(quote.ethRequired, 0);
        _bid(thirdBidder, secondAuction, 0.2 ether, 0.204 ether);
        uint256 creditBefore = auctionHouse.credits(bidder);

        vm.prank(bidder);
        vm.expectRevert(
            abi.encodeWithSelector(
                AuctionHouse.AuctionCostTooHigh.selector, 0.515 ether, 0.51 ether
            )
        );
        auctionHouse.bid(secondAuction, 0.5 ether, quote.totalCost);

        assertEq(auctionHouse.credits(bidder), creditBefore);
        assertEq(auctionHouse.getAuction(secondAuction).highestBidder, thirdBidder);
        vm.prank(bidder);
        auctionHouse.bid(secondAuction, 0.5 ether, 0.515 ether);
        assertEq(auctionHouse.credits(bidder), creditBefore - 0.515 ether);
    }

    function testFuzz_MinimumKeepsSellerAhead(uint96 firstBid, uint96 offeredBid) public {
        firstBid = uint96(bound(firstBid, auctionHouse.MIN_STARTING_PRICE(), type(uint96).max));
        vm.deal(bidder, 1 << 128);
        vm.deal(nextBidder, 1 << 128);
        uint64 auctionId = _startAuction(seller, 1, firstBid, DURATION);
        _bid(bidder, auctionId, firstBid, firstBid);

        uint256 minimum = auctionHouse.minimumBid(auctionId);
        if (minimum > type(uint96).max) {
            vm.prank(nextBidder);
            vm.expectRevert(
                abi.encodeWithSelector(
                    AuctionHouse.AuctionBidTooLow.selector, type(uint96).max, minimum
                )
            );
            auctionHouse.bid(auctionId, type(uint96).max, type(uint256).max);
        } else {
            uint96 amount = uint96(bound(offeredBid, minimum, type(uint96).max));
            AuctionHouse.BidQuote memory quote =
                auctionHouse.quoteBid(auctionId, amount, nextBidder);
            _bid(nextBidder, auctionId, amount, quote.ethRequired);
            assertGe(auctionHouse.credits(bidder), firstBid);
        }

        vm.warp(block.timestamp + DURATION);
        vm.prank(settler);
        auctionHouse.settle(auctionId);
        if (minimum <= type(uint96).max) {
            assertGt(auctionHouse.credits(seller), auctionHouse.credits(bidder));
        }
        assertEq(
            address(auctionHouse).balance,
            auctionHouse.credits(seller) + auctionHouse.credits(settler)
                + auctionHouse.credits(bidder)
        );
    }

    function testFuzz_ConcurrentAuctionsRemainSolvent(uint256 seed) public {
        address[7] memory accounts =
            [seller, secondSeller, bidder, nextBidder, thirdBidder, fourthBidder, settler];
        for (uint256 i; i < accounts.length; ++i) {
            vm.deal(accounts[i], 1 << 128);
        }
        uint64[2] memory auctionIds = [
            _startAuction(seller, 1, auctionHouse.MIN_STARTING_PRICE(), DURATION),
            _startAuction(secondSeller, 3, 1 ether, DURATION * 2)
        ];
        uint256[2] memory previousCosts;
        uint256[2] memory previousPayouts;

        for (uint256 i; i < 40; ++i) {
            if (i == 20) {
                vm.warp(block.timestamp + DURATION);
                _settleAndAssert(auctionIds[0], previousPayouts[0]);
                _assertSolvent(accounts, auctionIds);
            }

            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 index = i < 20 ? seed % 2 : 1;
            uint64 auctionId = auctionIds[index];
            AuctionHouse.Auction memory previous = auctionHouse.getAuction(auctionId);
            uint256 accountIndex = 2 + ((seed >> 8) % 4);
            if (accounts[accountIndex] == previous.highestBidder) {
                accountIndex = accountIndex == 5 ? 2 : accountIndex + 1;
            }
            address account = accounts[accountIndex];
            if ((seed >> 16) % 3 == 0 && auctionHouse.credits(account) != 0) {
                vm.prank(account);
                auctionHouse.withdraw();
                _assertSolvent(accounts, auctionIds);
            }

            uint256 minimum = auctionHouse.minimumBid(auctionId);
            uint96 amount = uint96(minimum + ((seed >> 24) % ((minimum / 5) + 1)));
            AuctionHouse.BidQuote memory quote = auctionHouse.quoteBid(auctionId, amount, account);
            uint256 previousCredit = auctionHouse.credits(previous.highestBidder);
            _bid(account, auctionId, amount, quote.ethRequired);

            if (previous.highestBidder != address(0)) {
                uint256 payout = auctionHouse.credits(previous.highestBidder) - previousCredit;
                assertGe(payout, previousCosts[index]);
                previousPayouts[index] = payout;
            }
            previousCosts[index] = quote.totalCost;
            _assertSolvent(accounts, auctionIds);
        }

        vm.warp(block.timestamp + DURATION);
        _settleAndAssert(auctionIds[1], previousPayouts[1]);
        _assertSolvent(accounts, auctionIds);

        for (uint256 i; i < accounts.length; ++i) {
            if (auctionHouse.credits(accounts[i]) != 0) {
                vm.prank(accounts[i]);
                auctionHouse.withdraw();
                _assertSolvent(accounts, auctionIds);
            }
        }
        assertEq(address(auctionHouse).balance, 0);
    }

    function _settleAndAssert(uint64 auctionId, uint256 previousPayout) internal {
        AuctionHouse.Auction memory auction = auctionHouse.getAuction(auctionId);
        uint256 sellerCredit = auctionHouse.credits(auction.seller);
        uint256 settlerCredit = auctionHouse.credits(settler);
        uint256 protocolBalance = address(factory).balance;

        vm.prank(settler);
        auctionHouse.settle(auctionId);

        uint256 amount = auction.highestBidder == address(0) ? 0 : auction.highestBid;
        uint256 feePercent = auction.bidCount < 10 ? auction.bidCount : 10;
        uint256 fee = (amount * feePercent) / 100;
        uint256 reward = (amount - fee) / 100;
        uint256 proceeds = auctionHouse.credits(auction.seller) - sellerCredit;
        assertEq(address(factory).balance - protocolBalance, fee);
        assertEq(auctionHouse.credits(settler) - settlerCredit, reward);
        assertEq(proceeds, amount - fee - reward);
        if (auction.bidCount > 1) {
            assertGt(proceeds, previousPayout);
        }
        assertEq(
            collection.ownerOf(auction.tokenId),
            auction.highestBidder == address(0) ? auction.seller : auction.highestBidder
        );
    }

    function _assertSolvent(address[7] memory accounts, uint64[2] memory auctionIds) internal view {
        uint256 liabilities;
        for (uint256 i; i < accounts.length; ++i) {
            liabilities += auctionHouse.credits(accounts[i]);
        }
        for (uint256 i; i < auctionIds.length; ++i) {
            (,,,, address highestBidder, uint96 highestBid) = auctionHouse.auctions(auctionIds[i]);
            if (highestBidder != address(0)) {
                liabilities += highestBid;
            }
        }
        assertEq(address(auctionHouse).balance, liabilities);
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
        uint256 maxTotalCost = auctionHouse.quoteBid(auctionId, amount, account).totalCost;
        vm.prank(account);
        auctionHouse.bid{value: payment}(auctionId, amount, maxTotalCost);
    }

    receive() external payable {
        if (rejectETH) {
            revert ETHRejected();
        }
        if (rotateOwnerOnReceive) {
            factory.transferOwnership(seller);
        }
        if (reenterWithdrawal) {
            (bool success, bytes memory reason) =
                address(auctionHouse).call(abi.encodeCall(AuctionHouse.withdraw, ()));
            assertFalse(success);
            assertEq(reason, abi.encodeWithSelector(AuctionHouse.ReentrancyGuard.selector));
        }
    }
}
