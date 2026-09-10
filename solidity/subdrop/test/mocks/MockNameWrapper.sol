// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {
    CANNOT_UNWRAP,
    PARENT_CANNOT_CONTROL,
    PARENT_CONTROLLED_FUSES
} from "../../src/interfaces/INameWrapper.sol";

interface IERC1155Receiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        returns (bytes4);
}

/// @dev Mirrors the NameWrapper rules Subdrop depends on: operator approval, expiry clamping,
/// PARENT_CANNOT_CONTROL protection, the CANNOT_UNWRAP parent requirement, and receiver checks.
contract MockNameWrapper {
    struct Name {
        address owner;
        uint32 fuses;
        uint64 expiry;
    }

    mapping(uint256 id => Name) internal names;
    mapping(address account => mapping(address operator => bool)) public isApprovedForAll;
    mapping(bytes32 node => address) public resolverOf;
    mapping(bytes32 node => string) public labelOf;

    error Unauthorised(bytes32 node, address sender);
    error OperationProhibited(bytes32 node);
    error TransferToNonReceiver();

    function wrap(bytes32 node, address owner, uint32 fuses, uint64 expiry) external {
        names[uint256(node)] = Name({owner: owner, fuses: fuses, expiry: expiry});
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function ownerOf(uint256 id) public view returns (address owner) {
        (owner,,) = getData(id);
    }

    function getData(uint256 id) public view returns (address owner, uint32 fuses, uint64 expiry) {
        Name memory name = names[id];
        if (name.expiry < block.timestamp) {
            return (address(0), 0, name.expiry);
        }

        return (name.owner, name.fuses, name.expiry);
    }

    function setSubnodeRecord(
        bytes32 parentNode,
        string calldata label,
        address owner,
        address resolver,
        uint64,
        uint32 fuses,
        uint64 expiry
    ) external returns (bytes32 node) {
        (address parentOwner, uint32 parentFuses, uint64 parentExpiry) =
            getData(uint256(parentNode));
        if (parentOwner != msg.sender && !isApprovedForAll[parentOwner][msg.sender]) {
            revert Unauthorised(parentNode, msg.sender);
        }

        node = keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
        (, uint32 nodeFuses,) = getData(uint256(node));
        if (nodeFuses & PARENT_CANNOT_CONTROL != 0) {
            revert OperationProhibited(node);
        }
        if (fuses & PARENT_CONTROLLED_FUSES != 0 && parentFuses & CANNOT_UNWRAP == 0) {
            revert OperationProhibited(node);
        }

        if (expiry > parentExpiry) {
            expiry = parentExpiry;
        }
        names[uint256(node)] = Name({owner: owner, fuses: fuses, expiry: expiry});
        resolverOf[node] = resolver;
        labelOf[node] = label;

        _acceptanceCheck(address(0), owner, uint256(node));
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata)
        external
    {
        if (from != msg.sender && !isApprovedForAll[from][msg.sender]) {
            revert Unauthorised(bytes32(id), msg.sender);
        }
        if (ownerOf(id) != from || amount != 1) {
            revert Unauthorised(bytes32(id), from);
        }

        names[id].owner = to;
        _acceptanceCheck(from, to, id);
    }

    function _acceptanceCheck(address from, address to, uint256 id) internal {
        if (to.code.length == 0) {
            return;
        }

        bytes4 response = IERC1155Receiver(to).onERC1155Received(msg.sender, from, id, 1, "");
        if (response != IERC1155Receiver.onERC1155Received.selector) {
            revert TransferToNonReceiver();
        }
    }
}
