// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {AuctionHouse} from "./AuctionHouse.sol";

contract AuctionHouseFactory {
    address public immutable implementation;

    address public owner;
    bool private locked;

    mapping(address collection => address auctionHouse) public auctionHouseFor;

    error AuctionHouseAlreadyDeployed();
    error IncorrectAmount();
    error InvalidCollection();
    error NoFunds();
    error NotCollectionHolder();
    error ReentrancyGuard();
    error TransferETHFailed();
    error Unauthorized();
    error ZeroAddress();

    event AuctionHouseDeployed(
        address indexed collection, address indexed auctionHouse, address indexed deployer
    );
    event ProtocolFeesWithdrawn(address indexed recipient, uint256 amount);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    constructor() {
        owner = msg.sender;
        implementation = address(new AuctionHouse(address(this)));
    }

    modifier nonReentrant() {
        if (locked) {
            revert ReentrancyGuard();
        }
        locked = true;
        _;
        locked = false;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert Unauthorized();
        }
        _;
    }

    function deployAuctionHouse(address collection)
        external
        nonReentrant
        returns (address auctionHouse)
    {
        if (auctionHouseFor[collection] != address(0)) {
            revert AuctionHouseAlreadyDeployed();
        }
        _validateCollection(collection);
        if (IERC721(collection).balanceOf(msg.sender) == 0) {
            revert NotCollectionHolder();
        }

        auctionHouse = Clones.clone(implementation);
        AuctionHouse(auctionHouse).initialize(collection);
        auctionHouseFor[collection] = auctionHouse;

        emit AuctionHouseDeployed(collection, auctionHouse, msg.sender);
    }

    function withdrawProtocolFees(uint256 amount) external onlyOwner nonReentrant {
        uint256 available = address(this).balance;
        uint256 withdrawal = amount == 0 ? available : amount;
        if (withdrawal == 0) {
            revert NoFunds();
        }
        if (withdrawal > available) {
            revert IncorrectAmount();
        }

        (bool success,) = payable(owner).call{value: withdrawal}("");
        if (!success) {
            revert TransferETHFailed();
        }

        emit ProtocolFeesWithdrawn(owner, withdrawal);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) {
            revert ZeroAddress();
        }

        address oldOwner = owner;
        owner = newOwner;

        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function _validateCollection(address collection) internal view {
        if (collection.code.length == 0) {
            revert InvalidCollection();
        }

        try IERC165(collection).supportsInterface(type(IERC721).interfaceId) returns (
            bool supported
        ) {
            if (!supported) {
                revert InvalidCollection();
            }
        } catch {
            revert InvalidCollection();
        }
    }

    receive() external payable {}
}
