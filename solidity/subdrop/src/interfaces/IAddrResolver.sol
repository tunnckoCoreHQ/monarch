// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

interface IAddrResolver {
    function setAddr(bytes32 node, address a) external;
}
