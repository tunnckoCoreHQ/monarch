// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC721A} from "erc721a/IERC721A.sol";

import {INekoGenerator} from "../src/INekoGenerator.sol";
import {NekoGenerator} from "../src/NekoGenerator.sol";
import {NekoPFP} from "../src/NekoPFP.sol";

/// @notice End-to-end tests using only the production generator and production NFT contract.
contract NekoEndToEndTest is Test {
    struct BasicPair {
        uint256 first;
        uint256 second;
        bytes32 signature;
    }

    struct VariantCoverage {
        uint256 bodyColors;
        uint256 headColors;
        uint256 tailColors;
        uint256 legColors;
        uint256 skyColors;
        uint256 faceColors;
        uint256 eyeColors;
        uint256 mouthColors;
        uint256 toys;
        uint256 eyeMasks;
        uint256 legMasks;
        uint256 alternateHeadStates;
        uint256 alternateMouthStates;
        uint256 alternateTailStates;
        uint256 visibleEyeMasks;
        uint256 visibleLegMasks;
        uint256 visibleMouthStates;
        uint256 matrixEyeStates;
        uint256 matrixMouthStates;
        uint256 invisibleEyeStates;
        uint256 invisibleMouthStates;
        uint256 visibleBlack;
        uint256 visibleWhite;
        bool sawVisible;
        bool sawMatrix;
        bool sawInvisible;
        bool sawInitialCandidate;
        bool sawRetriedCandidate;
    }

    address private constant SEA_DROP = address(0x5EA);
    address private constant ALICE = address(0xA11CE);
    uint256 private constant INTENDED_SUPPLY = 4663;
    uint256 private constant PRIMARY_COLOR_QUOTA = 96;
    uint16 private constant ALL_PARTS_MASK = 0x1fff;
    uint16 private constant PARTIAL_MUTATION_MASK = 0x0aac;
    bytes32 private constant GENESIS_SEED = keccak256("NekoPFPv3.actual-contract.seed");
    bytes32 private constant GENESIS_SEED_COMMITMENT_DOMAIN =
        keccak256("NekoPFPSeaDrop.genesisSeedCommitment.v1");
    bytes32 private constant TOKEN_SEED_DOMAIN = keccak256("NekoPFPSeaDrop.tokenSeed.v1");

    NekoGenerator private generator;
    NekoPFP private neko;

    function setUp() public {
        generator = new NekoGenerator();
        address[] memory allowedSeaDrop = new address[](1);
        allowedSeaDrop[0] = SEA_DROP;
        bytes32 commitment = keccak256(abi.encode(GENESIS_SEED_COMMITMENT_DOMAIN, GENESIS_SEED));
        neko = new NekoPFP("Neko", "NEKO", allowedSeaDrop, generator, commitment);

        vm.prank(SEA_DROP);
        neko.mintSeaDrop(ALICE, INTENDED_SUPPLY);
        neko.reveal(GENESIS_SEED);
    }

    function testActualCollectionExercisesEveryProductionDerivationVariant() public view {
        VariantCoverage memory coverage;
        for (uint256 startTokenId = 1; startTokenId <= INTENDED_SUPPLY; startTokenId += 128) {
            uint256 endTokenId = startTokenId + 127;
            if (endTokenId > INTENDED_SUPPLY) {
                endTokenId = INTENDED_SUPPLY;
            }
            VariantCoverage memory batch = this.scanActualRange(startTokenId, endTokenId);
            _mergeVariantCoverage(coverage, batch);
        }

        _assertCompleteVariantCoverage(coverage);
    }

    function scanActualRange(uint256 startTokenId, uint256 endTokenId)
        external
        view
        returns (VariantCoverage memory coverage)
    {
        for (uint256 tokenId = startTokenId; tokenId <= endTokenId; ++tokenId) {
            uint256 seed = neko.seedOf(tokenId);
            INekoGenerator.TokenData memory data = neko.tokenData(tokenId);
            assertEq(data.fusionMass, 1, "unfused production token has wrong mass");
            _recordTraitCoverage(coverage, data.traits);

            uint256 initialCandidate = uint256(
                keccak256(abi.encode(TOKEN_SEED_DOMAIN, GENESIS_SEED, tokenId, uint256(0)))
            );
            if (seed == initialCandidate) {
                coverage.sawInitialCandidate = true;
            } else {
                coverage.sawRetriedCandidate = true;
            }
        }
    }

    function testActualNftMatchesProductionGeneratorAcrossCollectionSamples() public view {
        for (uint256 tokenId = 1; tokenId <= INTENDED_SUPPLY; tokenId += 73) {
            uint256 seed = neko.seedOf(tokenId);
            INekoGenerator.RawTraits memory nftTraits = neko.tokenData(tokenId).traits;
            INekoGenerator.RawTraits memory generatorTraits = generator.deriveRawTraits(seed);

            assertEq(
                keccak256(abi.encode(nftTraits)),
                keccak256(abi.encode(generatorTraits)),
                "NFT traits differ from production generator"
            );
        }

        uint256 lastSeed = neko.seedOf(INTENDED_SUPPLY);
        assertEq(
            keccak256(abi.encode(neko.tokenData(INTENDED_SUPPLY).traits)),
            keccak256(abi.encode(generator.deriveRawTraits(lastSeed))),
            "last NFT traits differ from production generator"
        );
    }

    function testActualBasicDuplicateCatsCanMerge() public {
        BasicPair memory duplicates = _findBasicDuplicatePair();
        INekoGenerator.TokenData memory firstBefore = neko.tokenData(duplicates.first);
        INekoGenerator.TokenData memory secondBefore = neko.tokenData(duplicates.second);
        bytes32 metadataBefore = keccak256(bytes(neko.tokenURI(duplicates.first)));

        assertEq(
            generator.catSignature(firstBefore.traits),
            generator.catSignature(secondBefore.traits),
            "discovered production cats are not duplicates"
        );

        vm.prank(ALICE);
        neko.merge(duplicates.first, duplicates.second);

        bytes32 metadataAfter = _assertActualTokenState(
            duplicates.first, firstBefore.traits, 2, _expectedSlopTier(firstBefore.traits)
        );
        assertTrue(metadataAfter != metadataBefore, "actual duplicate merge metadata was unchanged");
        assertEq(
            neko.duplicateMergeCount(duplicates.first), 1, "actual duplicate merge count mismatch"
        );
        assertEq(
            neko.mutationCount(duplicates.first), 0, "actual duplicate mutation count mismatch"
        );
        assertEq(
            neko.currentRoot(duplicates.first), 4665, "actual duplicate ancestry root mismatch"
        );
        assertEq(neko.totalSupply(), INTENDED_SUPPLY - 1, "actual duplicate was not burned");
        _assertAncestryNode(
            4665,
            uint16(duplicates.first + 1),
            uint16(duplicates.second + 1),
            NekoPFP.FusionAction.DuplicateMerge,
            0
        );
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        neko.ownerOf(duplicates.second);
    }

    function testActualPartialMutationPersistsProductionCombinedTraits() public {
        (uint256 survivorId, uint256 consumedId) = _findDifferentBasicPair();
        INekoGenerator.TokenData memory survivorBefore = neko.tokenData(survivorId);
        INekoGenerator.TokenData memory consumedBefore = neko.tokenData(consumedId);
        bytes32 metadataBefore = keccak256(bytes(neko.tokenURI(survivorId)));
        INekoGenerator.RawTraits memory expected = generator.combineRawTraits(
            survivorBefore.traits, consumedBefore.traits, PARTIAL_MUTATION_MASK
        );
        assertTrue(
            keccak256(abi.encode(expected)) != keccak256(abi.encode(survivorBefore.traits)),
            "selected production mutation has no effect"
        );

        vm.prank(ALICE);
        neko.mutate(survivorId, consumedId, PARTIAL_MUTATION_MASK);

        INekoGenerator.TokenData memory survivorAfter = neko.tokenData(survivorId);
        assertEq(
            keccak256(abi.encode(survivorAfter.traits)),
            keccak256(abi.encode(expected)),
            "actual NFT did not persist production-combined traits"
        );
        _assertActualTokenState(survivorId, expected, 2, _expectedSlopTier(expected));
        assertEq(neko.mutationCount(survivorId), 1, "actual mutation count mismatch");
        assertEq(neko.duplicateMergeCount(survivorId), 0, "actual mutation merge count mismatch");
        assertEq(neko.currentRoot(survivorId), 4665, "actual mutation ancestry root mismatch");
        assertEq(neko.totalSupply(), INTENDED_SUPPLY - 1, "actual mutation did not burn donor");
        _assertAncestryNode(
            4665,
            uint16(survivorId + 1),
            uint16(consumedId + 1),
            NekoPFP.FusionAction.Mutation,
            PARTIAL_MUTATION_MASK
        );
        string memory expectedMetadata = generator.generateTokenURI(survivorId, survivorAfter);
        bytes32 metadataAfter = keccak256(bytes(neko.tokenURI(survivorId)));
        assertTrue(metadataAfter != metadataBefore, "actual mutation did not update metadata");
        assertEq(
            metadataAfter,
            keccak256(bytes(expectedMetadata)),
            "actual NFT metadata differs from production renderer"
        );
    }

    function testTwoActualMutationTreesBecomeDuplicatesThenMerge() public {
        BasicPair memory duplicateDonors = _findBasicDuplicatePair();
        (uint256 firstSurvivor, uint256 secondSurvivor) =
            _findTwoDifferentBasicSurvivors(duplicateDonors);

        vm.prank(ALICE);
        neko.mutate(firstSurvivor, duplicateDonors.first, ALL_PARTS_MASK);
        vm.prank(ALICE);
        neko.mutate(secondSurvivor, duplicateDonors.second, ALL_PARTS_MASK);

        INekoGenerator.TokenData memory firstMutated = neko.tokenData(firstSurvivor);
        INekoGenerator.TokenData memory secondMutated = neko.tokenData(secondSurvivor);
        bytes32 firstSignature = generator.catSignature(firstMutated.traits);
        bytes32 secondSignature = generator.catSignature(secondMutated.traits);
        assertEq(firstSignature, secondSignature, "actual mutation trees did not become duplicates");
        assertEq(firstMutated.fusionMass, 2, "first actual mutation tree mass mismatch");
        assertEq(secondMutated.fusionMass, 2, "second actual mutation tree mass mismatch");
        _assertActualTokenState(
            firstSurvivor, firstMutated.traits, 2, _expectedSlopTier(firstMutated.traits)
        );
        _assertActualTokenState(
            secondSurvivor, secondMutated.traits, 2, _expectedSlopTier(secondMutated.traits)
        );

        vm.prank(ALICE);
        neko.merge(firstSurvivor, secondSurvivor);

        INekoGenerator.TokenData memory merged = neko.tokenData(firstSurvivor);
        _assertActualTokenState(firstSurvivor, merged.traits, 4, _expectedSlopTier(merged.traits));
        assertEq(neko.mutationCount(firstSurvivor), 2, "actual tree mutation count mismatch");
        assertEq(neko.duplicateMergeCount(firstSurvivor), 1, "actual tree merge count mismatch");
        assertEq(neko.currentRoot(firstSurvivor), 4667, "actual combined ancestry root mismatch");
        assertEq(neko.totalSupply(), INTENDED_SUPPLY - 3, "actual interaction burn count mismatch");

        (uint16 parentA, uint16 parentB, NekoPFP.FusionAction action, uint16 mutationMask) =
            neko.ancestryNode(4667);
        assertEq(parentA, 4665, "actual combined tree first parent mismatch");
        assertEq(parentB, 4666, "actual combined tree second parent mismatch");
        assertEq(
            uint256(action),
            uint256(NekoPFP.FusionAction.DuplicateMerge),
            "actual combined tree action mismatch"
        );
        assertEq(mutationMask, 0, "actual combined tree merge mask mismatch");

        string memory expectedMetadata = generator.generateTokenURI(firstSurvivor, merged);
        assertEq(
            keccak256(bytes(neko.tokenURI(firstSurvivor))),
            keccak256(bytes(expectedMetadata)),
            "actual merged-tree metadata differs from production renderer"
        );
    }

    function testActualFusionProgressionChecksEveryIntermediateState() public {
        BasicPair memory duplicateDonors = _findBasicDuplicatePair();
        (uint256 survivorId,) = _findTwoDifferentBasicSurvivors(duplicateDonors);
        INekoGenerator.RawTraits memory initialTraits = neko.tokenData(survivorId).traits;
        INekoGenerator.TokenData memory duplicateDonorData = neko.tokenData(duplicateDonors.first);
        uint256 finalDonorId = _findEffectiveBasicMutationDonor(
            duplicateDonorData.traits, survivorId, duplicateDonors.first, duplicateDonors.second
        );
        INekoGenerator.RawTraits memory finalDonorTraits = neko.tokenData(finalDonorId).traits;

        bytes32 metadataHash = _assertActualTokenState(survivorId, initialTraits, 1, 0);
        assertEq(neko.mutationCount(survivorId), 0, "mass-one mutation count mismatch");
        assertEq(neko.duplicateMergeCount(survivorId), 0, "mass-one merge count mismatch");
        assertEq(neko.currentRoot(survivorId), survivorId + 1, "mass-one ancestry root mismatch");

        INekoGenerator.RawTraits memory massTwoTraits =
            generator.combineRawTraits(initialTraits, duplicateDonorData.traits, ALL_PARTS_MASK);
        vm.prank(ALICE);
        neko.mutate(survivorId, duplicateDonors.first, ALL_PARTS_MASK);

        bytes32 massTwoMetadata = _assertActualTokenState(survivorId, massTwoTraits, 2, 0);
        assertTrue(massTwoMetadata != metadataHash, "mass-two metadata was unchanged");
        assertEq(neko.mutationCount(survivorId), 1, "mass-two mutation count mismatch");
        assertEq(neko.duplicateMergeCount(survivorId), 0, "mass-two merge count mismatch");
        assertEq(neko.currentRoot(survivorId), 4665, "mass-two ancestry root mismatch");
        assertEq(neko.totalSupply(), INTENDED_SUPPLY - 1, "mass-two supply mismatch");
        _assertAncestryNode(
            4665,
            uint16(survivorId + 1),
            uint16(duplicateDonors.first + 1),
            NekoPFP.FusionAction.Mutation,
            ALL_PARTS_MASK
        );

        vm.prank(ALICE);
        neko.merge(survivorId, duplicateDonors.second);

        bytes32 massThreeMetadata = _assertActualTokenState(survivorId, massTwoTraits, 3, 0);
        assertTrue(massThreeMetadata != massTwoMetadata, "mass-three metadata was unchanged");
        assertEq(neko.mutationCount(survivorId), 1, "mass-three mutation count mismatch");
        assertEq(neko.duplicateMergeCount(survivorId), 1, "mass-three merge count mismatch");
        assertEq(neko.currentRoot(survivorId), 4666, "mass-three ancestry root mismatch");
        assertEq(neko.totalSupply(), INTENDED_SUPPLY - 2, "mass-three supply mismatch");
        _assertAncestryNode(
            4666, 4665, uint16(duplicateDonors.second + 1), NekoPFP.FusionAction.DuplicateMerge, 0
        );

        INekoGenerator.RawTraits memory massFourTraits =
            generator.combineRawTraits(massTwoTraits, finalDonorTraits, PARTIAL_MUTATION_MASK);
        uint8 massFourSlopTier = _expectedSlopTier(massFourTraits);
        assertTrue(massFourSlopTier > 0, "mass-four mutation did not produce slop");
        vm.prank(ALICE);
        neko.mutate(survivorId, finalDonorId, PARTIAL_MUTATION_MASK);

        bytes32 massFourMetadata =
            _assertActualTokenState(survivorId, massFourTraits, 4, massFourSlopTier);
        assertTrue(massFourMetadata != massThreeMetadata, "mass-four metadata was unchanged");
        assertEq(neko.mutationCount(survivorId), 2, "mass-four mutation count mismatch");
        assertEq(neko.duplicateMergeCount(survivorId), 1, "mass-four merge count mismatch");
        assertEq(neko.currentRoot(survivorId), 4667, "mass-four ancestry root mismatch");
        assertEq(neko.totalSupply(), INTENDED_SUPPLY - 3, "mass-four supply mismatch");
        _assertAncestryNode(
            4667,
            4666,
            uint16(finalDonorId + 1),
            NekoPFP.FusionAction.Mutation,
            PARTIAL_MUTATION_MASK
        );
    }

    function _findBasicDuplicatePair() private view returns (BasicPair memory pair) {
        bytes32[] memory signatures = new bytes32[](INTENDED_SUPPLY);
        uint256[] memory tokenIds = new uint256[](INTENDED_SUPPLY);
        uint256 basicCount;

        for (uint256 tokenId = 1; tokenId <= INTENDED_SUPPLY; ++tokenId) {
            INekoGenerator.RawTraits memory traits = neko.tokenData(tokenId).traits;
            if (!_isBasic(traits)) {
                continue;
            }

            bytes32 signature = generator.catSignature(traits);
            for (uint256 i; i < basicCount; ++i) {
                if (signatures[i] == signature) {
                    return BasicPair(tokenIds[i], tokenId, signature);
                }
            }
            signatures[basicCount] = signature;
            tokenIds[basicCount] = tokenId;
            ++basicCount;
        }
        revert("actual collection contains no basic duplicate pair");
    }

    function _findDifferentBasicPair()
        private
        view
        returns (uint256 firstTokenId, uint256 secondTokenId)
    {
        bytes32 firstSignature;
        for (uint256 tokenId = 1; tokenId <= INTENDED_SUPPLY; ++tokenId) {
            INekoGenerator.RawTraits memory traits = neko.tokenData(tokenId).traits;
            if (!_isBasic(traits)) {
                continue;
            }

            bytes32 signature = generator.catSignature(traits);
            if (firstTokenId == 0) {
                firstTokenId = tokenId;
                firstSignature = signature;
            } else if (signature != firstSignature) {
                return (firstTokenId, tokenId);
            }
        }
        revert("actual collection contains no different basic pair");
    }

    function _findTwoDifferentBasicSurvivors(BasicPair memory donors)
        private
        view
        returns (uint256 firstSurvivor, uint256 secondSurvivor)
    {
        for (uint256 tokenId = 1; tokenId <= INTENDED_SUPPLY; ++tokenId) {
            if (tokenId == donors.first || tokenId == donors.second) {
                continue;
            }
            INekoGenerator.RawTraits memory traits = neko.tokenData(tokenId).traits;
            if (!_isBasic(traits) || generator.catSignature(traits) == donors.signature) {
                continue;
            }
            if (firstSurvivor == 0) {
                firstSurvivor = tokenId;
            } else {
                return (firstSurvivor, tokenId);
            }
        }
        revert("actual collection contains fewer than two mutation survivors");
    }

    function _findEffectiveBasicMutationDonor(
        INekoGenerator.RawTraits memory survivorTraits,
        uint256 survivorId,
        uint256 firstDuplicateId,
        uint256 secondDuplicateId
    ) private view returns (uint256 donorId) {
        bytes32 survivorSignature = generator.catSignature(survivorTraits);
        for (uint256 tokenId = 1; tokenId <= INTENDED_SUPPLY; ++tokenId) {
            if (
                tokenId == survivorId || tokenId == firstDuplicateId || tokenId == secondDuplicateId
            ) {
                continue;
            }

            INekoGenerator.RawTraits memory donorTraits = neko.tokenData(tokenId).traits;
            if (!_isBasic(donorTraits) || generator.catSignature(donorTraits) == survivorSignature)
            {
                continue;
            }

            INekoGenerator.RawTraits memory combined =
                generator.combineRawTraits(survivorTraits, donorTraits, PARTIAL_MUTATION_MASK);
            if (
                keccak256(abi.encode(combined)) != keccak256(abi.encode(survivorTraits))
                    && _expectedSlopTier(combined) > 0
            ) {
                return tokenId;
            }
        }
        revert("actual collection contains no effective slop-producing donor");
    }

    function _assertActualTokenState(
        uint256 tokenId,
        INekoGenerator.RawTraits memory expectedTraits,
        uint256 expectedMass,
        uint8 expectedSlopTier
    ) private view returns (bytes32 metadataHash) {
        INekoGenerator.TokenData memory actual = neko.tokenData(tokenId);
        INekoGenerator.TokenData memory canonical =
            generator.resolveTokenData(expectedTraits, expectedMass);
        assertEq(
            keccak256(abi.encode(actual.traits)),
            keccak256(abi.encode(expectedTraits)),
            "actual token traits mismatch"
        );
        assertEq(actual.fusionMass, expectedMass, "actual token fusion mass mismatch");
        assertEq(actual.slopTier, expectedSlopTier, "actual token slop tier mismatch");
        assertEq(
            keccak256(abi.encode(actual)),
            keccak256(abi.encode(canonical)),
            "actual token data differs from production resolver"
        );

        string memory expectedMetadata = generator.generateTokenURI(tokenId, actual);
        metadataHash = keccak256(bytes(neko.tokenURI(tokenId)));
        assertEq(
            metadataHash,
            keccak256(bytes(expectedMetadata)),
            "actual token metadata differs from production renderer"
        );
    }

    function _assertAncestryNode(
        uint16 nodeId,
        uint16 expectedParentA,
        uint16 expectedParentB,
        NekoPFP.FusionAction expectedAction,
        uint16 expectedMutationMask
    ) private view {
        (uint16 parentA, uint16 parentB, NekoPFP.FusionAction action, uint16 mutationMask) =
            neko.ancestryNode(nodeId);
        assertEq(parentA, expectedParentA, "actual ancestry first parent mismatch");
        assertEq(parentB, expectedParentB, "actual ancestry second parent mismatch");
        assertEq(uint256(action), uint256(expectedAction), "actual ancestry action mismatch");
        assertEq(mutationMask, expectedMutationMask, "actual ancestry mutation mask mismatch");
    }

    function _expectedSlopTier(INekoGenerator.RawTraits memory traits)
        private
        pure
        returns (uint8 tier)
    {
        if (traits.alternateHead) {
            ++tier;
        }
        if (traits.alternateEyeMask != 0) {
            ++tier;
        }
        if (traits.alternateMouth) {
            ++tier;
        }
        if (traits.alternateLegMask != 0) {
            ++tier;
        }
        if (traits.alternateTail) {
            ++tier;
        }
    }

    function _recordTraitCoverage(
        VariantCoverage memory coverage,
        INekoGenerator.RawTraits memory traits
    ) private pure {
        coverage.bodyColors |= uint256(1) << traits.body;
        coverage.headColors |= uint256(1) << traits.head;
        coverage.tailColors |= uint256(1) << traits.tail;
        coverage.faceColors |= uint256(1) << traits.face;
        coverage.mouthColors |= uint256(1) << traits.mouth;
        coverage.toys |= uint256(1) << traits.toy;
        coverage.eyeMasks |= uint256(1) << traits.alternateEyeMask;
        coverage.legMasks |= uint256(1) << traits.alternateLegMask;
        coverage.alternateHeadStates |= uint256(1) << (traits.alternateHead ? 1 : 0);
        coverage.alternateMouthStates |= uint256(1) << (traits.alternateMouth ? 1 : 0);
        coverage.alternateTailStates |= uint256(1) << (traits.alternateTail ? 1 : 0);
        for (uint256 i; i < 4; ++i) {
            coverage.legColors |= uint256(1) << traits.legs[i];
        }
        for (uint256 i; i < 2; ++i) {
            coverage.eyeColors |= uint256(1) << traits.eyes[i];
        }

        if (traits.matrix) {
            coverage.sawMatrix = true;
            coverage.matrixEyeStates |= uint256(1) << (traits.alternateEyeMask != 0 ? 1 : 0);
            coverage.matrixMouthStates |= uint256(1) << (traits.alternateMouth ? 1 : 0);
            assertEq(traits.sky, 0, "matrix token has nonzero sky");
            assertTrue(!traits.invisible, "matrix token is also invisible");
            assertTrue(traits.body != 16, "matrix token has black body");
            return;
        }

        coverage.skyColors |= uint256(1) << traits.sky;
        if (traits.invisible) {
            coverage.sawInvisible = true;
            coverage.invisibleEyeStates |= uint256(1) << (traits.alternateEyeMask != 0 ? 1 : 0);
            coverage.invisibleMouthStates |= uint256(1) << (traits.alternateMouth ? 1 : 0);
            _assertInvisibleBodyMatchesSky(traits);
            return;
        }

        coverage.sawVisible = true;
        coverage.visibleEyeMasks |= uint256(1) << traits.alternateEyeMask;
        coverage.visibleLegMasks |= uint256(1) << traits.alternateLegMask;
        coverage.visibleMouthStates |= uint256(1) << (traits.alternateMouth ? 1 : 0);
        if (traits.body == 16) {
            ++coverage.visibleBlack;
        } else if (traits.body == 17) {
            ++coverage.visibleWhite;
        }
    }

    function _assertCompleteVariantCoverage(VariantCoverage memory coverage) private pure {
        assertEq(coverage.bodyColors, (uint256(1) << 20) - 1, "not every body color was derived");
        assertEq(coverage.headColors, (uint256(1) << 20) - 1, "not every head color was derived");
        assertEq(coverage.tailColors, (uint256(1) << 20) - 1, "not every tail color was derived");
        assertEq(coverage.legColors, (uint256(1) << 20) - 1, "not every leg color was derived");
        assertEq(coverage.skyColors, (uint256(1) << 20) - 1, "not every sky color was derived");
        assertEq(coverage.faceColors, (uint256(1) << 13) - 1, "not every face color was derived");
        assertEq(coverage.eyeColors, (uint256(1) << 13) - 1, "not every eye color was derived");
        assertEq(coverage.mouthColors, (uint256(1) << 13) - 1, "not every mouth color was derived");
        assertEq(coverage.toys, (uint256(1) << 37) - 1, "not every toy was derived");
        assertEq(coverage.eyeMasks, 0x7, "not every natural eye variant was derived");
        assertEq(coverage.legMasks, 0x117, "not every natural leg variant was derived");
        assertEq(coverage.alternateHeadStates, 0x3, "alternate head did not exercise both states");
        assertEq(coverage.alternateMouthStates, 0x3, "alternate mouth did not exercise both states");
        assertEq(coverage.alternateTailStates, 0x3, "alternate tail did not exercise both states");
        assertEq(coverage.visibleEyeMasks, 0x7, "visible eye variants are incomplete");
        assertEq(coverage.visibleLegMasks, 0x117, "visible leg variants are incomplete");
        assertEq(coverage.visibleMouthStates, 0x3, "visible mouth variants are incomplete");
        assertEq(coverage.matrixEyeStates, 0x3, "matrix eye variants are incomplete");
        assertEq(coverage.matrixMouthStates, 0x3, "matrix mouth variants are incomplete");
        assertEq(coverage.invisibleEyeStates, 0x3, "invisible eye variants are incomplete");
        assertEq(coverage.invisibleMouthStates, 0x3, "invisible mouth variants are incomplete");
        assertEq(coverage.visibleBlack, PRIMARY_COLOR_QUOTA, "actual visible black quota mismatch");
        assertEq(coverage.visibleWhite, PRIMARY_COLOR_QUOTA, "actual visible white quota mismatch");
        assertTrue(coverage.sawVisible, "actual collection has no visible tokens");
        assertTrue(coverage.sawMatrix, "actual collection has no matrix tokens");
        assertTrue(coverage.sawInvisible, "actual collection has no invisible tokens");
        assertTrue(coverage.sawInitialCandidate, "actual collection never accepted an initial seed");
        assertTrue(coverage.sawRetriedCandidate, "actual collection never exercised seed retry");
    }

    function _mergeVariantCoverage(VariantCoverage memory coverage, VariantCoverage memory batch)
        private
        pure
    {
        coverage.bodyColors |= batch.bodyColors;
        coverage.headColors |= batch.headColors;
        coverage.tailColors |= batch.tailColors;
        coverage.legColors |= batch.legColors;
        coverage.skyColors |= batch.skyColors;
        coverage.faceColors |= batch.faceColors;
        coverage.eyeColors |= batch.eyeColors;
        coverage.mouthColors |= batch.mouthColors;
        coverage.toys |= batch.toys;
        coverage.eyeMasks |= batch.eyeMasks;
        coverage.legMasks |= batch.legMasks;
        coverage.alternateHeadStates |= batch.alternateHeadStates;
        coverage.alternateMouthStates |= batch.alternateMouthStates;
        coverage.alternateTailStates |= batch.alternateTailStates;
        coverage.visibleEyeMasks |= batch.visibleEyeMasks;
        coverage.visibleLegMasks |= batch.visibleLegMasks;
        coverage.visibleMouthStates |= batch.visibleMouthStates;
        coverage.matrixEyeStates |= batch.matrixEyeStates;
        coverage.matrixMouthStates |= batch.matrixMouthStates;
        coverage.invisibleEyeStates |= batch.invisibleEyeStates;
        coverage.invisibleMouthStates |= batch.invisibleMouthStates;
        coverage.visibleBlack += batch.visibleBlack;
        coverage.visibleWhite += batch.visibleWhite;
        coverage.sawVisible = coverage.sawVisible || batch.sawVisible;
        coverage.sawMatrix = coverage.sawMatrix || batch.sawMatrix;
        coverage.sawInvisible = coverage.sawInvisible || batch.sawInvisible;
        coverage.sawInitialCandidate = coverage.sawInitialCandidate || batch.sawInitialCandidate;
        coverage.sawRetriedCandidate = coverage.sawRetriedCandidate || batch.sawRetriedCandidate;
    }

    function _isBasic(INekoGenerator.RawTraits memory traits) private pure returns (bool) {
        return !traits.matrix && !traits.invisible && !traits.alternateHead
            && !traits.alternateMouth && !traits.alternateTail && traits.alternateEyeMask == 0
            && traits.alternateLegMask == 0;
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
