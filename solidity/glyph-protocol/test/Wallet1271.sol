// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ECDSA} from "solady/utils/ECDSA.sol";

/// @dev Minimal ERC-1271 wallet: valid iff the ECDSA signer is `OWNER`.
///      Accepts malleable (high-`s`) signatures on purpose, like solady's
///      `tryRecover` does.
contract Wallet1271 {
    address internal immutable OWNER;

    constructor(address owner) {
        OWNER = owner;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        if (ECDSA.tryRecover(hash, signature) == OWNER) {
            return 0x1626ba7e;
        }

        return 0xffffffff;
    }
}
