// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ILaunchLocker} from "./openlaunch/OpenLaunchInterfaces.sol";

interface IERC721Transfer {
    function transferFrom(address from, address to, uint256 id) external;
}

interface IERC1155Transfer {
    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata data
    ) external;
    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) external;
}

/// Fixed OpenLaunch fee recipient. Burns the launch token, forwards everything else to the
/// operating account, and pays the caller a share of what gets forwarded.
contract MewsForwarder is Ownable {
    using SafeTransferLib for address;

    error BurnedToken();
    error InvalidReward();

    event Flushed(address indexed caller, uint256 burned, uint256 forwarded, uint256 reward);
    event Forwarded(
        address indexed caller, address indexed erc20, uint256 forwarded, uint256 reward
    );
    event RewardUpdated(uint256 bps);

    uint256 public constant MIN_REWARD_BPS = 100;
    uint256 public constant MAX_REWARD_BPS = 1000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    ILaunchLocker public immutable locker;
    address public immutable token;
    address public immutable account;
    uint256 public rewardBps = MIN_REWARD_BPS;

    constructor(ILaunchLocker locker_, address token_, address account_) {
        locker = locker_;
        token = token_;
        account = account_;
        _initializeOwner(account_);
    }

    // The locker pushes ETH with a 50,000 gas cap, so receiving must stay cheap.
    receive() external payable {}

    function flush() external {
        uint256 tokenId = locker.tokenIdOf(token);
        if (tokenId != 0) {
            locker.collect(tokenId);
        }

        uint256 burned = token.balanceOf(address(this));
        if (burned != 0) {
            token.safeTransfer(DEAD, burned);
        }

        uint256 reward = _reward(address(this).balance);
        if (reward != 0) {
            msg.sender.safeTransferETH(reward);
        }
        uint256 forwarded = address(this).balance;
        if (forwarded != 0) {
            account.safeTransferETH(forwarded);
        }
        emit Flushed(msg.sender, burned, forwarded, reward);
    }

    function forward(address erc20) external {
        if (erc20 == token) {
            revert BurnedToken();
        }

        // Forward what remains after the reward, so a fee-on-transfer token cannot get stuck.
        uint256 reward = _reward(erc20.balanceOf(address(this)));
        if (reward != 0) {
            erc20.safeTransfer(msg.sender, reward);
        }
        uint256 forwarded = erc20.balanceOf(address(this));
        if (forwarded != 0) {
            erc20.safeTransfer(account, forwarded);
        }
        emit Forwarded(msg.sender, erc20, forwarded, reward);
    }

    function forwardNFT(address collection, uint256 id) external {
        IERC721Transfer(collection).transferFrom(address(this), account, id);
    }

    function onERC721Received(address, address, uint256 id, bytes calldata)
        external
        returns (bytes4)
    {
        IERC721Transfer(msg.sender).transferFrom(address(this), account, id);
        return this.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256 id, uint256 amount, bytes calldata)
        external
        returns (bytes4)
    {
        IERC1155Transfer(msg.sender).safeTransferFrom(address(this), account, id, amount, "");
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata
    ) external returns (bytes4) {
        IERC1155Transfer(msg.sender).safeBatchTransferFrom(address(this), account, ids, amounts, "");
        return this.onERC1155BatchReceived.selector;
    }

    function setReward(uint256 bps) external onlyOwner {
        if (bps < MIN_REWARD_BPS || bps > MAX_REWARD_BPS) {
            revert InvalidReward();
        }
        rewardBps = bps;
        emit RewardUpdated(bps);
    }

    function _reward(uint256 amount) private view returns (uint256) {
        return amount * rewardBps / 10_000;
    }
}
