// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";

import {INekoGenerator} from "../src/INekoGenerator.sol";
import {NekoBase} from "../src/NekoBase.sol";
import {NekoGenerator} from "../src/NekoGenerator.sol";

contract NekoGeneratorTest is Test {
    NekoGenerator private generator;

    function setUp() public {
        generator = new NekoGenerator();
    }

    function testGenerationProfileMatchesDerivedTraits() public view {
        for (uint256 seed; seed < 128; ++seed) {
            INekoGenerator.RawTraits memory traits = generator.deriveRawTraits(seed);
            (bool matrix, bool invisible, uint8 bodyIndex) = generator.generationProfile(seed);

            assertEq(traits.matrix, matrix, "matrix profile differs from raw traits");
            assertEq(traits.invisible, invisible, "invisible profile differs from raw traits");
            assertEq(traits.body, bodyIndex, "body profile differs from raw traits");
            assertTrue(!(matrix && bodyIndex == 16), "matrix profile selected a black body");
        }
    }

    function testResolveComputesFusionSummaryAndRejectsInvalidMass() public {
        INekoGenerator.RawTraits memory traits = generator.deriveRawTraits(0xdecafbad);
        INekoGenerator.TokenData memory data = generator.resolveTokenData(traits, 8);

        assertEq(data.fusionMass, 8, "fusion mass changed during resolution");
        assertEq(
            keccak256(abi.encode(data.traits)), keccak256(abi.encode(traits)), "traits changed"
        );

        vm.expectRevert(NekoBase.InvalidFusionMass.selector);
        generator.resolveTokenData(traits, 0);
    }

    function testCombineAllPartsReproducesConsumedTraits() public view {
        INekoGenerator.RawTraits memory survivor = generator.deriveRawTraits(0x1111);
        INekoGenerator.RawTraits memory consumed = generator.deriveRawTraits(0x2222);
        INekoGenerator.RawTraits memory combined =
            generator.combineRawTraits(survivor, consumed, 0x1fff);

        assertEq(
            keccak256(abi.encode(combined)),
            keccak256(abi.encode(consumed)),
            "all-parts mutation did not reproduce consumed traits"
        );
    }

    function testCatSignatureIgnoresToyAndRejectsEmptyMutationMask() public {
        INekoGenerator.RawTraits memory traits = generator.deriveRawTraits(0x3333);
        bytes32 signature = generator.catSignature(traits);
        traits.toy = traits.toy == 36 ? 0 : traits.toy + 1;

        assertEq(generator.catSignature(traits), signature, "toy changed the cat signature");

        vm.expectRevert(NekoBase.InvalidMutationSelectionMask.selector);
        generator.combineRawTraits(traits, traits, 0);
    }

    function testRenderedUrisStaySelfContainedAndHashExactBytes() public view {
        uint256 seed = 0x4444;
        uint256 tokenId = 42;
        INekoGenerator.RawTraits memory traits = generator.deriveRawTraits(seed);
        INekoGenerator.TokenData memory data = generator.resolveTokenData(traits, 2);

        string memory svg = generator.generateSVG(seed, data);
        (string memory imageURI, bytes32 contentHash) = generator.generateImageURI(seed, data);
        string memory tokenURI = generator.generateTokenURI(seed, tokenId, data);

        assertTrue(LibString.startsWith(svg, "<svg "), "rendered SVG has no root element");
        assertTrue(LibString.contains(svg, "fusion-diamond"), "fused SVG has no star marker");
        assertTrue(
            LibString.startsWith(imageURI, "data:image/svg+xml;base64,"),
            "image URI is not embedded"
        );
        assertEq(contentHash, keccak256(bytes(imageURI)), "content hash does not cover image URI");
        assertTrue(
            LibString.startsWith(tokenURI, "data:application/json;base64,"),
            "token metadata is not embedded"
        );
    }

    function testUnrevealedMetadataUsesSharedImageAndTokenSpecificName() public view {
        string memory imageURI = generator.generateUnrevealedImageURI();
        string memory tokenURI = generator.generateUnrevealedTokenURI(7);
        string memory nextTokenURI = generator.generateUnrevealedTokenURI(8);

        assertTrue(
            LibString.startsWith(imageURI, "data:image/svg+xml;base64,"),
            "unrevealed image is not embedded"
        );
        assertTrue(
            LibString.startsWith(tokenURI, "data:application/json;base64,"),
            "unrevealed metadata is not embedded"
        );
        assertTrue(
            keccak256(bytes(tokenURI)) != keccak256(bytes(nextTokenURI)),
            "unrevealed metadata does not include the token id"
        );
    }

    function testDerivedTraitsMaintainStructuralInvariantsAcrossBroadSeedSet() public view {
        for (uint256 i; i < 1024; ++i) {
            uint256 seed = uint256(keccak256(abi.encode("structural invariant sample", i)));
            INekoGenerator.RawTraits memory traits = generator.deriveRawTraits(seed);

            _assertTraitRanges(traits);
            _assertDerivedFlags(traits);
            if (traits.matrix) {
                assertEq(traits.sky, 0, "matrix sky is not canonical");
                assertTrue(!traits.invisible, "matrix token is also invisible");
                assertTrue(traits.body != 16, "matrix token has black body");
            }
            if (traits.invisible) {
                _assertInvisibleBodyMatchesSky(traits);
            }
        }
    }

    function testSelectiveCombinationCopiesRequestedPartsAndPreservesTheRest() public view {
        INekoGenerator.RawTraits memory survivor = generator.deriveRawTraits(0x51a7);
        INekoGenerator.RawTraits memory consumed = generator.deriveRawTraits(0xc0ffee);
        uint16 mask = 0x1245;

        INekoGenerator.RawTraits memory combined =
            generator.combineRawTraits(survivor, consumed, mask);

        assertEq(combined.sky, consumed.sky, "selected sky was not copied");
        assertEq(combined.face, consumed.face, "selected face was not copied");
        assertEq(combined.legs[1], consumed.legs[1], "selected leg was not copied");
        assertEq(combined.eyes[0], consumed.eyes[0], "selected eye was not copied");
        assertEq(combined.toy, consumed.toy, "selected toy was not copied");
        assertEq(combined.head, survivor.head, "unselected head changed");
        assertEq(combined.body, survivor.body, "unselected body changed");
        assertEq(combined.tail, survivor.tail, "unselected tail changed");
        assertEq(combined.mouth, survivor.mouth, "unselected mouth changed");
        assertEq(combined.legs[0], survivor.legs[0], "unselected leg changed");
        assertEq(combined.eyes[1], survivor.eyes[1], "unselected eye changed");
        _assertDerivedFlags(combined);
    }

    function testRenderingCoversEveryPaletteColorAndToy() public view {
        bytes32 previousHash;
        for (uint8 color; color < 20; ++color) {
            INekoGenerator.RawTraits memory traits = _uniformTraits(color, color);
            bytes32 currentHash = _renderVariant(color, color + 1, traits, 1);
            if (color != 0) {
                assertTrue(currentHash != previousHash, "palette color did not change metadata");
            }
            previousHash = currentHash;
        }

        previousHash = bytes32(0);
        for (uint8 toy; toy < 37; ++toy) {
            INekoGenerator.RawTraits memory traits = _uniformTraits(5, toy);
            bytes32 currentHash = _renderVariant(toy, toy + 1, traits, 1);
            if (toy != 0) {
                assertTrue(currentHash != previousHash, "toy did not change metadata");
            }
            previousHash = currentHash;
        }
    }

    function testComplexAlternateAndSpecialClassMetadataCombinations() public view {
        INekoGenerator.RawTraits memory matrix = _uniformTraits(5, 36);
        matrix.sky = 0;
        matrix.matrix = true;
        bytes32 matrixHash = _renderVariant(0xaaaa, 1, matrix, 2);

        INekoGenerator.RawTraits memory invisible = _uniformTraits(7, 35);
        invisible.sky = 7;
        invisible.invisible = true;
        bytes32 invisibleHash = _renderVariant(0xbbbb, 2, invisible, 3);

        bytes32 leftEyeHash = _renderVariant(0xcccc, 3, _alternateTraits(1, 4), 17);
        bytes32 rightEyeHash = _renderVariant(0xdddd, 4, _alternateTraits(2, 8), 17);
        bytes32 multiAlternateHash = _renderVariant(0xeeee, 5, _alternateTraits(3, 5), 17);

        assertTrue(matrixHash != invisibleHash, "special classes rendered identical metadata");
        assertTrue(leftEyeHash != rightEyeHash, "eye sides rendered identical metadata");
        assertTrue(
            multiAlternateHash != leftEyeHash,
            "multi-alternate metadata collapsed to single alternate"
        );
    }

    function testRejectsMalformedNestedTraitsAndDerivedFlags() public {
        INekoGenerator.RawTraits memory traits = _uniformTraits(5, 1);
        traits.sky = 20;
        _expectInvalidRawTraits(traits);

        traits = _uniformTraits(5, 1);
        traits.legs[2] = 20;
        _expectInvalidRawTraits(traits);

        traits = _uniformTraits(5, 1);
        traits.eyes[1] = 13;
        _expectInvalidRawTraits(traits);

        traits = _uniformTraits(5, 1);
        traits.alternateHead = true;
        _expectInvalidRawTraits(traits);

        traits = _uniformTraits(5, 1);
        traits.invisible = true;
        _expectInvalidRawTraits(traits);
    }

    function testRenderingRejectsInconsistentTokenSummary() public {
        INekoGenerator.RawTraits memory traits = _alternateTraits(1, 1);
        INekoGenerator.TokenData memory data = generator.resolveTokenData(traits, 8);

        data.slopTier += 1;
        vm.expectRevert(NekoBase.InvalidTokenData.selector);
        generator.generateSVG(1, data);

        data = generator.resolveTokenData(traits, 8);
        data.fusionMass = 0;
        vm.expectRevert(NekoBase.InvalidFusionMass.selector);
        generator.generateTokenURI(1, 1, data);

        data.fusionMass = 4664;
        vm.expectRevert(NekoBase.InvalidFusionMass.selector);
        generator.generateTokenURI(1, 1, data);
    }

    function _expectInvalidRawTraits(INekoGenerator.RawTraits memory traits) private {
        vm.expectRevert(NekoBase.InvalidRawTraits.selector);
        generator.resolveTokenData(traits, 1);
    }

    function _renderVariant(
        uint256 seed,
        uint256 tokenId,
        INekoGenerator.RawTraits memory traits,
        uint256 fusionMass
    ) private view returns (bytes32 tokenURIHash) {
        INekoGenerator.TokenData memory data = generator.resolveTokenData(traits, fusionMass);
        string memory svg = generator.generateSVG(seed, data);
        (string memory imageURI, bytes32 contentHash) = generator.generateImageURI(seed, data);
        string memory tokenURI = generator.generateTokenURI(seed, tokenId, data);

        assertTrue(LibString.startsWith(svg, "<svg "), "variant SVG has no root element");
        assertTrue(LibString.contains(svg, 'id="toy"'), "variant SVG omitted toy");
        assertTrue(
            LibString.startsWith(imageURI, "data:image/svg+xml;base64,"),
            "variant image is not embedded"
        );
        assertEq(contentHash, keccak256(bytes(imageURI)), "variant image hash mismatch");
        assertTrue(
            LibString.startsWith(tokenURI, "data:application/json;base64,"),
            "variant metadata is not embedded"
        );
        return keccak256(bytes(tokenURI));
    }

    function _uniformTraits(uint8 body, uint8 toy)
        private
        pure
        returns (INekoGenerator.RawTraits memory traits)
    {
        traits.sky = body == 0 ? 1 : 0;
        traits.head = body;
        traits.face = body % 13;
        traits.body = body;
        traits.tail = body;
        traits.mouth = traits.face;
        traits.toy = toy;
        for (uint256 i; i < 4; ++i) {
            traits.legs[i] = body;
        }
        for (uint256 i; i < 2; ++i) {
            traits.eyes[i] = traits.face;
        }
    }

    function _alternateTraits(uint8 eyeMask, uint8 legMask)
        private
        pure
        returns (INekoGenerator.RawTraits memory traits)
    {
        traits = _uniformTraits(5, 36);
        traits.head = 6;
        traits.tail = 7;
        traits.mouth = 2;
        traits.alternateHead = true;
        traits.alternateMouth = true;
        traits.alternateTail = true;
        traits.alternateEyeMask = eyeMask;
        traits.alternateLegMask = legMask;
        for (uint8 i; i < 2; ++i) {
            if (eyeMask & (uint8(1) << i) != 0) {
                traits.eyes[i] = uint8(3 + i);
            }
        }
        for (uint8 i; i < 4; ++i) {
            if (legMask & (uint8(1) << i) != 0) {
                traits.legs[i] = uint8(8 + i);
            }
        }
    }

    function _assertTraitRanges(INekoGenerator.RawTraits memory traits) private pure {
        assertTrue(traits.sky < 20, "sky is outside palette");
        assertTrue(traits.head < 20, "head is outside palette");
        assertTrue(traits.face < 13, "face is outside face palette");
        assertTrue(traits.body < 20, "body is outside palette");
        assertTrue(traits.tail < 20, "tail is outside palette");
        assertTrue(traits.mouth < 13, "mouth is outside face palette");
        assertTrue(traits.toy < 37, "toy is outside collection");
        for (uint256 i; i < 4; ++i) {
            assertTrue(traits.legs[i] < 20, "leg is outside palette");
        }
        for (uint256 i; i < 2; ++i) {
            assertTrue(traits.eyes[i] < 13, "eye is outside face palette");
        }
    }

    function _assertDerivedFlags(INekoGenerator.RawTraits memory traits) private pure {
        uint8 expectedLegMask;
        for (uint8 i; i < 4; ++i) {
            if (traits.legs[i] != traits.body) {
                expectedLegMask |= uint8(1) << i;
            }
        }
        uint8 expectedEyeMask;
        for (uint8 i; i < 2; ++i) {
            if (traits.eyes[i] != traits.face) {
                expectedEyeMask |= uint8(1) << i;
            }
        }

        assertEq(traits.alternateHead, traits.head != traits.body, "alternate head flag mismatch");
        assertEq(
            traits.alternateMouth, traits.mouth != traits.face, "alternate mouth flag mismatch"
        );
        assertEq(traits.alternateTail, traits.tail != traits.body, "alternate tail flag mismatch");
        assertEq(traits.alternateLegMask, expectedLegMask, "alternate leg mask mismatch");
        assertEq(traits.alternateEyeMask, expectedEyeMask, "alternate eye mask mismatch");
    }

    function _assertInvisibleBodyMatchesSky(INekoGenerator.RawTraits memory traits) private pure {
        assertEq(traits.head, traits.sky, "invisible head differs from sky");
        assertEq(traits.body, traits.sky, "invisible body differs from sky");
        assertEq(traits.tail, traits.sky, "invisible tail differs from sky");
        for (uint256 i; i < 4; ++i) {
            assertEq(traits.legs[i], traits.sky, "invisible leg differs from sky");
        }
    }
}
