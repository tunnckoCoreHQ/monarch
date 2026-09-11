// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {NekoRenderer} from "../src/NekoRenderer.sol";
import {NekoSeaDrop} from "../src/NekoSeaDrop.sol";
import {NekoArt} from "../src/NekoArt.sol";
import {ISeaDrop, INonFungibleSeaDropToken} from "../src/seadrop/SeaDropInterfaces.sol";
import {NekoTestBase} from "./NekoTestBase.sol";

contract NekoMintTest is NekoTestBase {
    function testConstructorRejectsZeroSeaDrop() public {
        vm.expectRevert(NekoSeaDrop.InvalidSeaDrop.selector);
        new NekoSeaDrop(
            _commitment(GENESIS_SEED), NekoRenderer(address(generator)), ISeaDrop(address(0))
        );
    }

    function testConstructorRejectsZeroGenerator() public {
        vm.expectRevert(NekoArt.GeneratorAddressIsZero.selector);
        _deploy(NekoRenderer(address(0)), _commitment(GENESIS_SEED));
    }

    function testConstructorRejectsZeroSeedCommitment() public {
        vm.expectRevert(NekoArt.GenesisSeedCommitmentIsZero.selector);
        _deploy(NekoRenderer(address(generator)), bytes32(0));
    }

    function testSeaDropMintUsesConfiguredRecipientAndQuantity() public {
        _mint(ALICE, 3);

        assertEq(neko.totalSupply(), 3, "live supply mismatch");
        assertEq(neko.balanceOf(ALICE), 3, "recipient balance mismatch");
        assertEq(neko.ownerOf(1), ALICE, "first token owner mismatch");
    }

    function testMintRejectsCallersOutsideAllowedSeaDrop() public {
        vm.prank(BOB);
        vm.expectRevert(INonFungibleSeaDropToken.OnlyAllowedSeaDrop.selector);
        neko.mintSeaDrop(ALICE, 1);
    }

    function testMintRejectsQuantityAboveMaxSupply() public {
        vm.prank(SEA_DROP);
        vm.expectRevert(NekoArt.SupplyExceeded.selector);
        neko.mintSeaDrop(ALICE, INTENDED_SUPPLY + 1);
    }
}
