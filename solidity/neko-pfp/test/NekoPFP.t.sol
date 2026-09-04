// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {INekoGenerator} from "../src/INekoGenerator.sol";
import {NekoPFP} from "../src/NekoPFP.sol";
import {ERC721SeaDropCompat} from "../src/seadrop/ERC721SeaDropCompat.sol";
import {INonFungibleSeaDropToken} from "../src/seadrop/INonFungibleSeaDropToken.sol";
import {NekoTestBase} from "./NekoTestBase.sol";

contract NekoPFPTest is NekoTestBase {
    function testConstructorRejectsZeroGenerator() public {
        vm.expectRevert(NekoPFP.GeneratorAddressIsZero.selector);
        _deploy(INekoGenerator(address(0)), _commitment(GENESIS_SEED));
    }

    function testConstructorRejectsZeroSeedCommitment() public {
        vm.expectRevert(NekoPFP.GenesisSeedCommitmentIsZero.selector);
        _deploy(generator, bytes32(0));
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
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC721SeaDropCompat.MintQuantityExceedsMaxSupply.selector,
                INTENDED_SUPPLY + 1,
                INTENDED_SUPPLY
            )
        );
        neko.mintSeaDrop(ALICE, INTENDED_SUPPLY + 1);
    }
}
