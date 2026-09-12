// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ILaunchFactory, ILaunchLocker} from "./openlaunch/OpenLaunchInterfaces.sol";

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

/// Fixed OpenLaunch fee recipient. Burns the launch token, sends ETH and other tokens to the
/// automation, NFTs to the operating account, and pays the caller a share of what it settles.
contract MewsForwarder is Ownable {
    using SafeTransferLib for address;

    error BurnedToken();
    error InvalidReward();
    error NotHolder();

    event Flushed(address indexed caller, uint256 burned);
    event Forwarded(
        address indexed caller, address indexed currency, uint256 forwarded, uint256 reward
    );
    event RewardUpdated(uint256 bps);
    event MinTokensUpdated(uint256 minTokens);

    uint256 public constant MIN_REWARD_BPS = 100;
    uint256 public constant MAX_REWARD_BPS = 1000;
    address public constant NATIVE = address(0);
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    ILaunchFactory public immutable factory;
    ILaunchLocker public immutable locker;
    address public immutable token;
    address public immutable account;
    address public immutable automation;
    uint256 public rewardBps = MIN_REWARD_BPS;
    uint256 public minTokens = 100_000 ether;

    constructor(ILaunchFactory factory_, address token_, address account_, address automation_) {
        factory = factory_;
        locker = factory_.locker();
        token = token_;
        account = account_;
        automation = automation_;
        _initializeOwner(account_);
    }

    // The locker pushes ETH with a 50,000 gas cap, so receiving must stay cheap.
    receive() external payable {}

    modifier onlyHolder() {
        if (token.balanceOf(msg.sender) < minTokens) {
            revert NotHolder();
        }
        _;
    }

    // Holders of enough of the token collect the fees, burn the token, and settle
    // ETH plus the launch's quote currency to the automation.
    function flush() external onlyHolder {
        (uint256 tokenId,, address quote,,) = factory.infoOf(token);
        if (tokenId != 0) {
            locker.collect(tokenId);
        }

        uint256 burned = token.balanceOf(address(this));
        if (burned != 0) {
            token.safeTransfer(DEAD, burned);
        }
        emit Flushed(msg.sender, burned);

        _settle(NATIVE);
        if (quote != NATIVE) {
            _settle(quote);
        }
    }

    function forward(address erc20) external onlyHolder {
        if (erc20 == token) {
            revert BurnedToken();
        }
        _settle(erc20);
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

    function setMinTokens(uint256 minTokens_) external onlyOwner {
        minTokens = minTokens_;
        emit MinTokensUpdated(minTokens_);
    }

    // The automation is paid before the caller, so reentering from the reward finds nothing left.
    function _settle(address currency) private {
        uint256 balance = _balance(currency);
        uint256 forwarded = balance - balance * rewardBps / 10_000;
        if (forwarded != 0) {
            _pay(currency, automation, forwarded);
        }
        uint256 reward = _balance(currency);
        if (reward != 0) {
            _pay(currency, msg.sender, reward);
        }
        emit Forwarded(msg.sender, currency, forwarded, reward);
    }

    function _balance(address currency) private view returns (uint256) {
        if (currency == NATIVE) {
            return address(this).balance;
        }
        return currency.balanceOf(address(this));
    }

    function _pay(address currency, address to, uint256 amount) private {
        if (currency == NATIVE) {
            to.safeTransferETH(amount);
            return;
        }
        currency.safeTransfer(to, amount);
    }
}
