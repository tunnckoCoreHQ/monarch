// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Counter} from "../src/Counter.sol";

contract CounterTest is Test {
    Counter internal counter;

    function setUp() public {
        counter = new Counter();
    }

    function test_StartsAtZero() public view {
        assertEq(counter.count(), 0);
    }

    function test_Increment() public {
        counter.increment();
        assertEq(counter.count(), 1);
    }

    function test_Decrement() public {
        counter.increment();
        counter.decrement();
        assertEq(counter.count(), 0);
    }

    function test_RevertWhen_DecrementAtZero() public {
        vm.expectRevert(Counter.Underflow.selector);
        counter.decrement();
    }

    function testFuzz_IncrementMany(uint8 times) public {
        for (uint256 i = 0; i < times; i++) {
            counter.increment();
        }
        assertEq(counter.count(), times);
    }
}
