// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {LibClone} from "solady/utils/LibClone.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {DropToken} from "./DropToken.sol";
import {IAddrResolver} from "./interfaces/IAddrResolver.sol";
import {
    CANNOT_UNWRAP,
    INameWrapper,
    PARENT_CANNOT_CONTROL,
    PARENT_CONTROLLED_FUSES
} from "./interfaces/INameWrapper.sol";

/// @notice Mint-to-earn for wrapped ENS names. The parent owner configures a token reward, and
/// anyone who mints a subname pays the price and receives the reward in the same transaction.
/// The parent owner keeps the name and the token treasury; Subdrop only needs NameWrapper
/// operator approval and an ERC20 allowance.
contract Subdrop {
    struct Drop {
        address owner;
        address token;
        address feeRecipient;
        uint96 price;
        uint96 reward;
        uint32 fuses;
        uint32 maxMints;
        uint32 minted;
        bool paused;
    }

    struct DropConfig {
        address token;
        address feeRecipient;
        uint96 price;
        uint96 reward;
        uint32 fuses;
        uint32 maxMints;
    }

    uint32 public constant DEFAULT_FUSES = PARENT_CANNOT_CONTROL | CANNOT_UNWRAP;

    INameWrapper public immutable nameWrapper;
    address public immutable resolver;
    address public immutable tokenImplementation;

    mapping(bytes32 parentNode => Drop) public drops;

    error DropNotFound();
    error DropIsPaused();
    error IncorrectPayment(uint256 actual, uint256 expected);
    error InvalidLabel();
    error LabelTaken();
    error MintedOut();
    error NotParentOwner();
    error ParentCannotBurnFuses();
    error ParentOwnerChanged();
    error ZeroAddress();

    event DropConfigured(
        bytes32 indexed parentNode,
        address indexed owner,
        address indexed token,
        address feeRecipient,
        uint96 price,
        uint96 reward,
        uint32 fuses,
        uint32 maxMints
    );
    event DropPaused(bytes32 indexed parentNode, bool paused);
    event TokenLaunched(
        bytes32 indexed parentNode, address indexed token, address indexed holder, uint256 supply
    );
    event Minted(
        bytes32 indexed parentNode,
        bytes32 indexed node,
        address indexed minter,
        string label,
        uint96 price,
        uint96 reward
    );

    constructor(address nameWrapper_, address resolver_) {
        if (nameWrapper_ == address(0) || resolver_ == address(0)) {
            revert ZeroAddress();
        }

        nameWrapper = INameWrapper(nameWrapper_);
        resolver = resolver_;
        tokenImplementation = address(new DropToken());
    }

    /// @notice Configure or update the drop for a wrapped parent name the caller owns.
    /// @dev The caller must also approve Subdrop as a NameWrapper operator and give it an ERC20
    /// allowance for the reward budget. The mint count is kept across reconfigurations.
    function configure(bytes32 parentNode, DropConfig calldata config) external {
        _configure(parentNode, config);
    }

    /// @notice Deploy a fixed-supply token to the caller and configure the drop in one call.
    /// @dev The token grants Subdrop an unlimited allowance from the caller at deployment, so
    /// only the NameWrapper operator approval remains.
    function launch(
        bytes32 parentNode,
        string calldata name,
        string calldata symbol,
        uint256 supply,
        DropConfig memory config
    ) external returns (address token) {
        token = LibClone.clone(tokenImplementation);
        DropToken(token).initialize(name, symbol, supply, msg.sender, address(this));
        emit TokenLaunched(parentNode, token, msg.sender, supply);

        config.token = token;
        _configure(parentNode, config);
    }

    function setPaused(bytes32 parentNode, bool paused) external {
        Drop storage drop = _existingDrop(parentNode);
        if (msg.sender != drop.owner) {
            revert NotParentOwner();
        }

        drop.paused = paused;
        emit DropPaused(parentNode, paused);
    }

    /// @notice Mint `label` under the parent to the caller and pay out the drop reward.
    function mint(bytes32 parentNode, string calldata label)
        external
        payable
        returns (bytes32 node)
    {
        Drop storage drop = _existingDrop(parentNode);
        if (drop.paused) {
            revert DropIsPaused();
        }
        if (nameWrapper.ownerOf(uint256(parentNode)) != drop.owner) {
            revert ParentOwnerChanged();
        }
        if (drop.maxMints != 0 && drop.minted >= drop.maxMints) {
            revert MintedOut();
        }
        if (msg.value != drop.price) {
            revert IncorrectPayment(msg.value, drop.price);
        }

        if (!_isValidLabel(label)) {
            revert InvalidLabel();
        }
        node = _subnode(parentNode, label);
        if (nameWrapper.ownerOf(uint256(node)) != address(0)) {
            revert LabelTaken();
        }

        drop.minted += 1;

        // Subdrop owns the subname for one call so it can set the address record.
        nameWrapper.setSubnodeRecord(
            parentNode, label, address(this), resolver, 0, drop.fuses, type(uint64).max
        );
        IAddrResolver(resolver).setAddr(node, msg.sender);
        nameWrapper.safeTransferFrom(address(this), msg.sender, uint256(node), 1, "");

        if (drop.reward != 0) {
            SafeTransferLib.safeTransferFrom(drop.token, drop.owner, msg.sender, drop.reward);
        }
        if (msg.value != 0) {
            SafeTransferLib.safeTransferETH(drop.feeRecipient, msg.value);
        }

        emit Minted(parentNode, node, msg.sender, label, drop.price, drop.reward);
    }

    function available(bytes32 parentNode, string calldata label) external view returns (bool) {
        if (!_isValidLabel(label)) {
            return false;
        }

        return nameWrapper.ownerOf(uint256(_subnode(parentNode, label))) == address(0);
    }

    /// @notice Mints still possible, bounded by the cap and by the owner's token budget.
    function remaining(bytes32 parentNode) external view returns (uint256 count) {
        Drop storage drop = drops[parentNode];
        if (drop.owner == address(0) || drop.paused) {
            return 0;
        }

        count = drop.maxMints == 0 ? type(uint256).max : drop.maxMints - drop.minted;
        if (drop.reward == 0) {
            return count;
        }

        uint256 allowance = DropToken(drop.token).allowance(drop.owner, address(this));
        uint256 balance = DropToken(drop.token).balanceOf(drop.owner);
        uint256 budget = allowance < balance ? allowance : balance;
        uint256 affordable = budget / drop.reward;

        return affordable < count ? affordable : count;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155Received.selector;
    }

    function _configure(bytes32 parentNode, DropConfig memory config) internal {
        if (nameWrapper.ownerOf(uint256(parentNode)) != msg.sender) {
            revert NotParentOwner();
        }
        if (config.token == address(0) || config.feeRecipient == address(0)) {
            revert ZeroAddress();
        }

        // NameWrapper only lets a parent burn parent-controlled fuses on children once it
        // has burned CANNOT_UNWRAP itself. Catch that here instead of at every mint.
        (, uint32 parentFuses,) = nameWrapper.getData(uint256(parentNode));
        bool burnsParentFuses = config.fuses & PARENT_CONTROLLED_FUSES != 0;
        bool parentCanUnwrap = parentFuses & CANNOT_UNWRAP == 0;
        if (burnsParentFuses && parentCanUnwrap) {
            revert ParentCannotBurnFuses();
        }

        Drop storage drop = drops[parentNode];
        drop.owner = msg.sender;
        drop.token = config.token;
        drop.feeRecipient = config.feeRecipient;
        drop.price = config.price;
        drop.reward = config.reward;
        drop.fuses = config.fuses;
        drop.maxMints = config.maxMints;

        emit DropConfigured(
            parentNode,
            msg.sender,
            config.token,
            config.feeRecipient,
            config.price,
            config.reward,
            config.fuses,
            config.maxMints
        );
    }

    function _existingDrop(bytes32 parentNode) internal view returns (Drop storage drop) {
        drop = drops[parentNode];
        if (drop.owner == address(0)) {
            revert DropNotFound();
        }
    }

    function _subnode(bytes32 parentNode, string calldata label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
    }

    /// @dev Rejects what can never be a normalized ENS label: empty, control characters, space,
    /// dots, ASCII uppercase, and DEL. Full normalization is the client's job.
    function _isValidLabel(string calldata label) internal pure returns (bool) {
        bytes calldata raw = bytes(label);
        if (raw.length == 0) {
            return false;
        }

        for (uint256 i = 0; i < raw.length; i++) {
            bytes1 char = raw[i];
            if (char <= 0x20 || char == 0x2E || char == 0x7F) {
                return false;
            }
            if (char >= 0x41 && char <= 0x5A) {
                return false;
            }
        }

        return true;
    }
}
