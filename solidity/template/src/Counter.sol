// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

contract Counter {
    error Underflow();

    uint256 public count;

    function increment() external {
        count += 1;
    }

    function decrement() external {
        if (count == 0) {
            revert Underflow();
        }
        count -= 1;
    }
}
