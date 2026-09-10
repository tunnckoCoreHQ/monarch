// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {MockNameWrapper} from "./MockNameWrapper.sol";

/// @dev PublicResolver authorises the NameWrapper owner of a wrapped node.
contract MockResolver {
    MockNameWrapper internal immutable nameWrapper;

    mapping(bytes32 node => address) public addr;

    error Unauthorised(bytes32 node, address sender);

    constructor(MockNameWrapper nameWrapper_) {
        nameWrapper = nameWrapper_;
    }

    function setAddr(bytes32 node, address a) external {
        if (nameWrapper.ownerOf(uint256(node)) != msg.sender) {
            revert Unauthorised(node, msg.sender);
        }

        addr[node] = a;
    }
}
