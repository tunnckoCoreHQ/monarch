// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {IERC721A} from "erc721a/IERC721A.sol";

import {NekoPFP} from "../src/NekoPFP.sol";
import {NekoTestBase} from "./NekoTestBase.sol";

contract NekoSeedSamplerTest is NekoTestBase {
    function testRejectsTokenIdsOutsideCollectionRange() public {
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        neko.deriveTokenSeed(GENESIS_SEED, 0);

        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        neko.deriveTokenSeed(GENESIS_SEED, INTENDED_SUPPLY + 1);
    }

    function testPreservesExactVisiblePrimaryColorQuotas() public view {
        uint256 visibleBlack;
        uint256 visibleWhite;
        for (uint256 tokenId = 1; tokenId <= INTENDED_SUPPLY; ++tokenId) {
            uint256 seed = neko.deriveTokenSeed(GENESIS_SEED, tokenId);
            (, bool invisible, uint8 bodyIndex) = generator.generationProfile(seed);
            if (!invisible && bodyIndex == 16) {
                ++visibleBlack;
            } else if (!invisible && bodyIndex == 17) {
                ++visibleWhite;
            }
        }

        assertEq(visibleBlack, PRIMARY_COLOR_QUOTA, "visible black quota mismatch");
        assertEq(visibleWhite, PRIMARY_COLOR_QUOTA, "visible white quota mismatch");
    }

    function testMatrixBlackProfileIsRejectedUntilSamplingExhausts() public {
        uint8 desiredClass = _desiredClassForToken(1);
        generator.setForcedProfile(true, true, false, 16);

        vm.expectRevert(
            abi.encodeWithSelector(NekoPFP.SeedSamplingExhausted.selector, 1, desiredClass)
        );
        neko.deriveTokenSeed(GENESIS_SEED, 1);
    }

    function testInvisibleProfileIsAcceptedOnlyForNonQuotaClass() public {
        (uint256 quotaTokenId, uint256 nonQuotaTokenId) = _quotaAndNonQuotaTokenIds();
        uint8 quotaClass = _desiredClassForToken(quotaTokenId);
        generator.setForcedProfile(true, false, true, 2);

        assertTrue(
            neko.deriveTokenSeed(GENESIS_SEED, nonQuotaTokenId) != 0,
            "invisible non-quota profile was rejected"
        );
        vm.expectRevert(
            abi.encodeWithSelector(NekoPFP.SeedSamplingExhausted.selector, quotaTokenId, quotaClass)
        );
        neko.deriveTokenSeed(GENESIS_SEED, quotaTokenId);
    }

    function _quotaAndNonQuotaTokenIds()
        private
        view
        returns (uint256 quotaTokenId, uint256 nonQuotaTokenId)
    {
        for (uint256 tokenId = 1; tokenId <= INTENDED_SUPPLY; ++tokenId) {
            uint8 desiredClass = _desiredClassForToken(tokenId);
            if (desiredClass == 0 && nonQuotaTokenId == 0) {
                nonQuotaTokenId = tokenId;
            } else if (desiredClass != 0 && quotaTokenId == 0) {
                quotaTokenId = tokenId;
            }
            if (quotaTokenId != 0 && nonQuotaTokenId != 0) {
                return (quotaTokenId, nonQuotaTokenId);
            }
        }
        revert("quota class search failed");
    }

    function _desiredClassForToken(uint256 tokenId) private view returns (uint8) {
        uint256 acceptedSeed = neko.deriveTokenSeed(GENESIS_SEED, tokenId);
        (, bool invisible, uint8 bodyIndex) = generator.generationProfile(acceptedSeed);
        if (invisible) {
            return 0;
        }
        if (bodyIndex == 16) {
            return 1;
        }
        if (bodyIndex == 17) {
            return 2;
        }
        return 0;
    }
}
