// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {INekoGenerator} from "../src/INekoGenerator.sol";
import {NekoGenerator} from "../src/NekoGenerator.sol";

contract NekoSeedSamplerTest is Test {
    NekoGenerator internal generator;
    bytes32 internal constant GENESIS_SEED = keccak256("NekoPFPv3SeaDrop.test.seed");

    function setUp() public {
        generator = new NekoGenerator();
    }

    function testRejectsTokenIdsOutsideCollectionRange() public {
        vm.expectRevert(INekoGenerator.InvalidTokenId.selector);
        generator.deriveTokenSeed(GENESIS_SEED, 0);
        vm.expectRevert(INekoGenerator.InvalidTokenId.selector);
        generator.deriveTokenSeed(GENESIS_SEED, 4664);
    }

    function testPreservesExactVisiblePrimaryColorQuotas() public view {
        uint256 visibleBlack;
        uint256 visibleWhite;
        for (uint256 tokenId = 1; tokenId <= 4663; ++tokenId) {
            uint256 seed = generator.deriveTokenSeed(GENESIS_SEED, tokenId);
            (bool matrix, bool invisible, uint8 bodyIndex) = generator.generationProfile(seed);
            assertFalse(matrix && bodyIndex == 16);
            if (!invisible && bodyIndex == 16) {
                ++visibleBlack;
            } else if (!invisible && bodyIndex == 17) {
                ++visibleWhite;
            }
        }
        assertEq(visibleBlack, 96);
        assertEq(visibleWhite, 96);
    }
}
