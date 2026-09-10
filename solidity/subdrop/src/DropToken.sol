// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ERC20} from "solady/tokens/ERC20.sol";

/// @notice Fixed-supply ERC20 deployed as a clone by Subdrop.launch.
contract DropToken is ERC20 {
    error AlreadyInitialized();

    string private _name;
    string private _symbol;
    bool private initialized;

    constructor() {
        initialized = true;
    }

    function initialize(
        string calldata name_,
        string calldata symbol_,
        uint256 supply,
        address holder,
        address spender
    ) external {
        if (initialized) {
            revert AlreadyInitialized();
        }
        initialized = true;

        _name = name_;
        _symbol = symbol_;
        _mint(holder, supply);
        _approve(holder, spender, type(uint256).max);
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }
}
