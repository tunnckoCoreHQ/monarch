// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

uint32 constant CANNOT_UNWRAP = 1;
uint32 constant PARENT_CANNOT_CONTROL = 1 << 16;
uint32 constant PARENT_CONTROLLED_FUSES = 0xFFFF0000;
uint32 constant USER_SETTABLE_FUSES = 0xFFFDFFFF;

/// @dev The subset of the ENS NameWrapper used by Subdrop.
interface INameWrapper {
    function setSubnodeRecord(
        bytes32 parentNode,
        string calldata label,
        address owner,
        address resolver,
        uint64 ttl,
        uint32 fuses,
        uint64 expiry
    ) external returns (bytes32 node);

    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata data
    ) external;

    function ownerOf(uint256 id) external view returns (address owner);

    function getData(uint256 id) external view returns (address owner, uint32 fuses, uint64 expiry);

    function isApprovedForAll(address account, address operator) external view returns (bool);
}
