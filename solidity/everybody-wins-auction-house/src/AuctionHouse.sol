// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

contract AuctionHouse is Initializable {
    struct Auction {
        uint256 tokenId;
        address seller;
        uint40 endTime;
        uint16 bidCount;
        address highestBidder;
        uint96 highestBid;
    }

    struct BidQuote {
        uint256 minimum;
        uint256 bonus;
        uint256 totalCost;
        uint256 creditUsed;
        uint256 ethRequired;
    }

    uint256 public constant BASE_INCREMENT = 5;
    uint256 public constant BONUS_INCREMENT = 1;
    uint256 public constant MAX_BONUS = 10;
    uint256 public constant MAX_HOUSE_FEE = 10;
    uint256 public constant SETTLER_REWARD_PERCENT = 1;

    address public immutable protocol;

    IERC721 public collection;
    uint64 public totalAuctions;
    bool private locked;

    mapping(uint64 auctionId => Auction) public auctions;
    mapping(address account => uint256 amount) public credits;

    error AlreadyHighestBidder();
    error AuctionBidTooLow(uint256 actual, uint256 minimum);
    error AuctionEnded();
    error AuctionNotEnded();
    error AuctionNotFound();
    error IncorrectPayment(uint256 actual, uint256 expected);
    error InvalidDuration();
    error NoFunds();
    error ReentrancyGuard();
    error SellerCannotBid();
    error TransferETHFailed();
    error Unauthorized();
    error ZeroAddress();

    event AuctionStarted(
        uint64 indexed auctionId,
        uint256 indexed tokenId,
        address indexed seller,
        uint96 startingPrice,
        uint256 startTime,
        uint40 endTime
    );
    event AuctionBidPlaced(
        uint64 indexed auctionId,
        address indexed bidder,
        uint96 indexed amount,
        address previousBidder,
        uint256 bonus,
        uint256 creditUsed
    );
    event AuctionSettled(
        uint64 indexed auctionId,
        uint256 indexed tokenId,
        address indexed winner,
        uint96 amount,
        uint256 sellerProceeds,
        uint256 houseFee,
        address settler,
        uint256 settlerReward
    );
    event FundsWithdrawn(address indexed account, uint256 amount);

    constructor(address protocol_) {
        if (protocol_ == address(0)) {
            revert ZeroAddress();
        }

        protocol = protocol_;
        _disableInitializers();
    }

    modifier nonReentrant() {
        if (locked) {
            revert ReentrancyGuard();
        }
        locked = true;
        _;
        locked = false;
    }

    function initialize(address collection_) external initializer {
        if (msg.sender != protocol) {
            revert Unauthorized();
        }
        if (collection_ == address(0)) {
            revert ZeroAddress();
        }

        collection = IERC721(collection_);
    }

    function startAuction(uint256 tokenId, uint96 startingPrice, uint40 duration)
        external
        nonReentrant
        returns (uint64 auctionId)
    {
        if (duration == 0) {
            revert InvalidDuration();
        }

        uint256 endTimestamp = block.timestamp + duration;
        if (endTimestamp > type(uint40).max) {
            revert InvalidDuration();
        }

        collection.transferFrom(msg.sender, address(this), tokenId);

        auctionId = totalAuctions + 1;
        uint40 endTime = uint40(endTimestamp);
        auctions[auctionId] = Auction({
            tokenId: tokenId,
            seller: msg.sender,
            endTime: endTime,
            bidCount: 0,
            highestBidder: address(0),
            highestBid: startingPrice
        });
        totalAuctions = auctionId;

        emit AuctionStarted(auctionId, tokenId, msg.sender, startingPrice, block.timestamp, endTime);
    }

    function bid(uint64 auctionId, uint96 bidAmount) external payable nonReentrant {
        Auction storage auction = _activeAuction(auctionId);
        if (block.timestamp >= auction.endTime) {
            revert AuctionEnded();
        }
        if (msg.sender == auction.seller) {
            revert SellerCannotBid();
        }
        if (msg.sender == auction.highestBidder) {
            revert AlreadyHighestBidder();
        }

        uint256 minimum = _minimumBid(auction.highestBid, auction.bidCount);
        if (bidAmount < minimum) {
            revert AuctionBidTooLow(bidAmount, minimum);
        }

        address previousBidder = auction.highestBidder;
        uint16 nextBidCount = auction.bidCount + 1;
        uint256 bonus = previousBidder == address(0) ? 0 : _calculateBonus(bidAmount, nextBidCount);
        uint256 totalCost = uint256(bidAmount) + bonus;

        uint256 accountCredit = credits[msg.sender];
        uint256 creditUsed = accountCredit < totalCost ? accountCredit : totalCost;
        uint256 ethRequired = totalCost - creditUsed;
        if (msg.value != ethRequired) {
            revert IncorrectPayment(msg.value, ethRequired);
        }

        if (creditUsed != 0) {
            credits[msg.sender] = accountCredit - creditUsed;
        }
        if (previousBidder != address(0)) {
            credits[previousBidder] += uint256(auction.highestBid) + bonus;
        }

        auction.highestBidder = msg.sender;
        auction.highestBid = bidAmount;
        auction.bidCount = nextBidCount;

        emit AuctionBidPlaced(auctionId, msg.sender, bidAmount, previousBidder, bonus, creditUsed);
    }

    function settle(uint64 auctionId) external nonReentrant {
        Auction memory auction = _activeAuction(auctionId);
        if (block.timestamp < auction.endTime) {
            revert AuctionNotEnded();
        }

        delete auctions[auctionId];

        address winner = auction.highestBidder;
        if (winner == address(0)) {
            collection.transferFrom(address(this), auction.seller, auction.tokenId);
            emit AuctionSettled(auctionId, auction.tokenId, address(0), 0, 0, 0, msg.sender, 0);
            return;
        }

        uint256 houseFee = _calculateHouseFee(auction.highestBid, auction.bidCount);
        uint256 sellerProceeds = uint256(auction.highestBid) - houseFee;
        uint256 settlerReward = (sellerProceeds * SETTLER_REWARD_PERCENT) / 100;
        sellerProceeds -= settlerReward;

        credits[auction.seller] += sellerProceeds;
        if (settlerReward != 0) {
            credits[msg.sender] += settlerReward;
        }

        if (houseFee != 0) {
            _transferETH(protocol, houseFee);
        }
        collection.transferFrom(address(this), winner, auction.tokenId);

        emit AuctionSettled(
            auctionId,
            auction.tokenId,
            winner,
            auction.highestBid,
            sellerProceeds,
            houseFee,
            msg.sender,
            settlerReward
        );
    }

    function withdraw() external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) {
            revert NoFunds();
        }

        credits[msg.sender] = 0;
        _transferETH(msg.sender, amount);

        emit FundsWithdrawn(msg.sender, amount);
    }

    function getAuction(uint64 auctionId) external view returns (Auction memory) {
        return _activeAuction(auctionId);
    }

    function canSettle(uint64 auctionId) external view returns (bool) {
        Auction storage auction = auctions[auctionId];
        return auction.seller != address(0) && block.timestamp >= auction.endTime;
    }

    function minimumBid(uint64 auctionId) external view returns (uint256) {
        Auction storage auction = _activeAuction(auctionId);
        return _minimumBid(auction.highestBid, auction.bidCount);
    }

    function quoteBid(uint64 auctionId, uint96 bidAmount, address bidder)
        external
        view
        returns (BidQuote memory quote)
    {
        Auction storage auction = _activeAuction(auctionId);
        uint16 nextBidCount = auction.bidCount + 1;
        uint256 bonus =
            auction.highestBidder == address(0) ? 0 : _calculateBonus(bidAmount, nextBidCount);
        uint256 totalCost = uint256(bidAmount) + bonus;
        uint256 accountCredit = credits[bidder];
        uint256 creditUsed = accountCredit < totalCost ? accountCredit : totalCost;

        quote = BidQuote({
            minimum: _minimumBid(auction.highestBid, auction.bidCount),
            bonus: bonus,
            totalCost: totalCost,
            creditUsed: creditUsed,
            ethRequired: totalCost - creditUsed
        });
    }

    function _activeAuction(uint64 auctionId) internal view returns (Auction storage auction) {
        auction = auctions[auctionId];
        if (auction.seller == address(0)) {
            revert AuctionNotFound();
        }
    }

    function _minimumBid(uint96 currentBid, uint16 bidCount) internal pure returns (uint256) {
        if (bidCount == 0) {
            return currentBid;
        }

        uint256 nextBidCount = uint256(bidCount) + 1;
        uint256 increment = BASE_INCREMENT + bidCount;
        uint256 escalatingMinimum = _ceilDiv(uint256(currentBid) * (100 + increment), 100);

        uint256 feePercent = _houseFeePercent(nextBidCount);
        uint256 bonusPercent = _bonusPercent(nextBidCount);
        uint256 sellerPercentAfterReward = (100 - feePercent) * (100 - SETTLER_REWARD_PERCENT);
        uint256 payoutDenominator = sellerPercentAfterReward - (bonusPercent * 100);
        uint256 sellerSafeMinimum = _ceilDiv((uint256(currentBid) + 1) * 10_000, payoutDenominator);

        return escalatingMinimum > sellerSafeMinimum ? escalatingMinimum : sellerSafeMinimum;
    }

    function _calculateBonus(uint96 amount, uint16 bidCount) internal pure returns (uint256) {
        return (uint256(amount) * _bonusPercent(bidCount)) / 100;
    }

    function _calculateHouseFee(uint96 amount, uint16 bidCount) internal pure returns (uint256) {
        return (uint256(amount) * _houseFeePercent(bidCount)) / 100;
    }

    function _bonusPercent(uint256 bidCount) internal pure returns (uint256) {
        uint256 percent = bidCount * BONUS_INCREMENT;
        return percent > MAX_BONUS ? MAX_BONUS : percent;
    }

    function _houseFeePercent(uint256 bidCount) internal pure returns (uint256) {
        return bidCount > MAX_HOUSE_FEE ? MAX_HOUSE_FEE : bidCount;
    }

    function _ceilDiv(uint256 value, uint256 divisor) internal pure returns (uint256) {
        return (value + divisor - 1) / divisor;
    }

    function _transferETH(address recipient, uint256 amount) internal {
        (bool success,) = payable(recipient).call{value: amount}("");
        if (!success) {
            revert TransferETHFailed();
        }
    }
}
