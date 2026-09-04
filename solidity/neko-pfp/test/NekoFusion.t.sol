// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {IERC721A} from "erc721a/IERC721A.sol";

import {INekoGenerator} from "../src/INekoGenerator.sol";
import {NekoPFP} from "../src/NekoPFP.sol";
import {NekoTestBase, TestableNekoPFP} from "./NekoTestBase.sol";

contract NekoFusionTest is NekoTestBase {
    function setUp() public override {
        super.setUp();
        _setRevealed();
    }

    function testMergeBurnsDuplicateAndCombinesMassAndAncestry() public {
        _mint(ALICE, 2);
        INekoGenerator.RawTraits memory duplicate = _baseTraits(5, 1);
        generator.setRawTraits(neko.seedOf(1), duplicate);
        duplicate.toy = 2;
        generator.setRawTraits(neko.seedOf(2), duplicate);

        vm.prank(ALICE);
        neko.merge(1, 2);

        assertEq(neko.totalSupply(), 1, "merge did not burn consumed token");
        assertEq(neko.fusionMass(1), 2, "merge mass mismatch");
        assertEq(neko.duplicateMergeCount(1), 1, "merge count mismatch");
        assertEq(neko.currentRoot(1), 4665, "ancestry root mismatch");
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        neko.ownerOf(2);
    }

    function testMutationCopiesSelectedPartAndPersistsTraits() public {
        _mint(ALICE, 2);
        generator.setRawTraits(neko.seedOf(1), _baseTraits(5, 1));
        generator.setRawTraits(neko.seedOf(2), _baseTraits(7, 2));

        vm.prank(ALICE);
        neko.mutate(1, 2, 0x0008);

        INekoGenerator.TokenData memory data = neko.tokenData(1);
        assertEq(data.traits.body, 7, "consumed body was not copied");
        assertEq(data.fusionMass, 2, "mutation mass mismatch");
        assertEq(neko.mutationCount(1), 1, "mutation count mismatch");
        assertEq(neko.totalSupply(), 1, "mutation did not burn consumed token");
    }

    function testRejectsSelfMergeAndSelfMutation() public {
        _mint(ALICE, 1);

        vm.prank(ALICE);
        vm.expectRevert(NekoPFP.CannotMergeTokenWithItself.selector);
        neko.merge(1, 1);

        vm.prank(ALICE);
        vm.expectRevert(NekoPFP.CannotMutateTokenWithItself.selector);
        neko.mutate(1, 1, 1);
    }

    function testRejectsEmptyAndOutOfRangeMutationMasks() public {
        _mint(ALICE, 2);

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(NekoPFP.InvalidMutationSelectionMask.selector, 0));
        neko.mutate(1, 2, 0);

        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(NekoPFP.InvalidMutationSelectionMask.selector, 0x2000)
        );
        neko.mutate(1, 2, 0x2000);
    }

    function testChainedMutationAndMergesAccumulateMassCountsAndAncestry() public {
        _mint(ALICE, 4);
        INekoGenerator.RawTraits memory survivor = _baseTraits(5, 1);
        INekoGenerator.RawTraits memory donor = _baseTraits(7, 2);
        INekoGenerator.RawTraits memory mutated =
            generator.combineRawTraits(survivor, donor, 0x0008);
        INekoGenerator.RawTraits memory firstDuplicate = mutated;
        INekoGenerator.RawTraits memory secondDuplicate = mutated;
        firstDuplicate.toy = 8;
        secondDuplicate.toy = 9;
        generator.setRawTraits(neko.seedOf(1), survivor);
        generator.setRawTraits(neko.seedOf(2), donor);
        generator.setRawTraits(neko.seedOf(3), firstDuplicate);
        generator.setRawTraits(neko.seedOf(4), secondDuplicate);

        vm.prank(ALICE);
        neko.mutate(1, 2, 0x0008);
        vm.prank(ALICE);
        neko.merge(1, 3);
        vm.prank(ALICE);
        neko.merge(1, 4);

        assertEq(neko.totalSupply(), 1, "chain did not burn every consumed token");
        assertEq(neko.fusionMass(1), 4, "chained fusion mass mismatch");
        assertEq(neko.mutationCount(1), 1, "chained mutation count mismatch");
        assertEq(neko.duplicateMergeCount(1), 2, "chained duplicate count mismatch");
        assertEq(neko.currentRoot(1), 4667, "chained ancestry root mismatch");
        assertEq(neko.nextNodeId(), 4668, "next ancestry node mismatch");

        _assertAncestryNode(
            4665, 2, 3, NekoPFP.FusionAction.Mutation, 0x0008, "mutation node mismatch"
        );
        _assertAncestryNode(
            4666, 4665, 4, NekoPFP.FusionAction.DuplicateMerge, 0, "first merge node mismatch"
        );
        _assertAncestryNode(
            4667, 4666, 5, NekoPFP.FusionAction.DuplicateMerge, 0, "second merge node mismatch"
        );
    }

    function testCombiningPreviouslyFusedTreesPreservesBothHistories() public {
        _mint(ALICE, 4);
        INekoGenerator.RawTraits memory first = _baseTraits(5, 1);
        INekoGenerator.RawTraits memory firstDonor = _baseTraits(7, 2);
        INekoGenerator.RawTraits memory second = _baseTraits(9, 3);
        INekoGenerator.RawTraits memory secondDuplicate = second;
        secondDuplicate.toy = 4;
        generator.setRawTraits(neko.seedOf(1), first);
        generator.setRawTraits(neko.seedOf(2), firstDonor);
        generator.setRawTraits(neko.seedOf(3), second);
        generator.setRawTraits(neko.seedOf(4), secondDuplicate);

        vm.prank(ALICE);
        neko.mutate(1, 2, 0x0008);
        vm.prank(ALICE);
        neko.merge(3, 4);
        vm.prank(ALICE);
        neko.mutate(1, 3, 0x0002);

        assertEq(neko.totalSupply(), 1, "tree combination live supply mismatch");
        assertEq(neko.fusionMass(1), 4, "tree combination mass mismatch");
        assertEq(neko.mutationCount(1), 2, "tree mutation history was not aggregated");
        assertEq(neko.duplicateMergeCount(1), 1, "tree merge history was not aggregated");
        assertEq(neko.currentRoot(1), 4667, "combined tree root mismatch");
        assertEq(neko.currentRoot(3), 4666, "consumed tree root history was erased");
        _assertAncestryNode(
            4667, 4665, 4666, NekoPFP.FusionAction.Mutation, 0x0002, "combined tree node mismatch"
        );
    }

    function testPerTokenApprovalsMustCoverBothMergeParticipants() public {
        _mint(ALICE, 2);
        INekoGenerator.RawTraits memory duplicate = _baseTraits(5, 1);
        generator.setRawTraits(neko.seedOf(1), duplicate);
        generator.setRawTraits(neko.seedOf(2), duplicate);

        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(NekoPFP.MergeCallerNotOwnerNorApproved.selector, 1));
        neko.merge(1, 2);

        vm.prank(ALICE);
        neko.approve(BOB, 1);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(NekoPFP.MergeCallerNotOwnerNorApproved.selector, 2));
        neko.merge(1, 2);

        vm.prank(ALICE);
        neko.approve(BOB, 2);
        vm.prank(BOB);
        neko.merge(1, 2);

        assertEq(neko.ownerOf(1), ALICE, "approved merge changed survivor owner");
        assertEq(neko.fusionMass(1), 2, "approved merge mass mismatch");
    }

    function testOperatorApprovalCanMutateBothTokens() public {
        _mint(ALICE, 2);
        generator.setRawTraits(neko.seedOf(1), _baseTraits(5, 1));
        generator.setRawTraits(neko.seedOf(2), _baseTraits(7, 2));
        vm.prank(ALICE);
        neko.setApprovalForAll(BOB, true);

        vm.prank(BOB);
        neko.mutate(1, 2, 0x0008);

        assertEq(neko.ownerOf(1), ALICE, "operator mutation changed survivor owner");
        assertEq(neko.fusionMass(1), 2, "operator mutation mass mismatch");
    }

    function testPerTokenApprovalsMustCoverBothMutationParticipants() public {
        _mint(ALICE, 2);
        generator.setRawTraits(neko.seedOf(1), _baseTraits(5, 1));
        generator.setRawTraits(neko.seedOf(2), _baseTraits(7, 2));

        vm.prank(BOB);
        vm.expectRevert(
            abi.encodeWithSelector(NekoPFP.MutationCallerNotOwnerNorApproved.selector, 1)
        );
        neko.mutate(1, 2, 0x0008);

        vm.prank(ALICE);
        neko.approve(BOB, 1);
        vm.prank(BOB);
        vm.expectRevert(
            abi.encodeWithSelector(NekoPFP.MutationCallerNotOwnerNorApproved.selector, 2)
        );
        neko.mutate(1, 2, 0x0008);
    }

    function testMergeRejectsDifferentSignatures() public {
        _mint(ALICE, 2);
        INekoGenerator.RawTraits memory survivor = _baseTraits(5, 1);
        INekoGenerator.RawTraits memory consumed = _baseTraits(7, 2);
        generator.setRawTraits(neko.seedOf(1), survivor);
        generator.setRawTraits(neko.seedOf(2), consumed);
        bytes32 survivorSignature = generator.catSignature(survivor);
        bytes32 consumedSignature = generator.catSignature(consumed);

        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                NekoPFP.CatSignatureMismatch.selector, survivorSignature, consumedSignature
            )
        );
        neko.merge(1, 2);
    }

    function testMutationRejectsMatchingSignaturesEvenWhenToysDiffer() public {
        _mint(ALICE, 2);
        INekoGenerator.RawTraits memory duplicate = _baseTraits(5, 1);
        generator.setRawTraits(neko.seedOf(1), duplicate);
        duplicate.toy = 2;
        generator.setRawTraits(neko.seedOf(2), duplicate);
        bytes32 signature = generator.catSignature(duplicate);

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(NekoPFP.CatSignatureMatch.selector, signature));
        neko.mutate(1, 2, 0x1000);
    }

    function testMutationRejectsSelectionThatDoesNotChangeSurvivor() public {
        _mint(ALICE, 2);
        INekoGenerator.RawTraits memory survivor = _baseTraits(5, 1);
        INekoGenerator.RawTraits memory consumed = _baseTraits(7, 1);
        generator.setRawTraits(neko.seedOf(1), survivor);
        generator.setRawTraits(neko.seedOf(2), consumed);

        vm.prank(ALICE);
        vm.expectRevert(NekoPFP.MutationHasNoEffect.selector);
        neko.mutate(1, 2, 0x1000);
    }

    function testFusionIsDisabledBeforeReveal() public {
        TestableNekoPFP unrevealed = _deploy(generator, _commitment(GENESIS_SEED));
        vm.prank(SEA_DROP);
        unrevealed.mintSeaDrop(ALICE, 2);

        vm.prank(ALICE);
        vm.expectRevert(NekoPFP.GenesisSeedNotRevealed.selector);
        unrevealed.merge(1, 1);

        vm.prank(ALICE);
        vm.expectRevert(NekoPFP.GenesisSeedNotRevealed.selector);
        unrevealed.mutate(1, 1, 0);

        assertEq(unrevealed.totalSupply(), 2, "unrevealed fusion changed supply");
        assertEq(unrevealed.ownerOf(1), ALICE, "unrevealed fusion changed first owner");
        assertEq(unrevealed.ownerOf(2), ALICE, "unrevealed fusion changed second owner");
    }

    function testFusionBurnClearsConsumedLiveStateButPreservesAncestry() public {
        _mint(ALICE, 3);
        INekoGenerator.RawTraits memory duplicate = _baseTraits(7, 2);
        generator.setRawTraits(neko.seedOf(1), _baseTraits(5, 1));
        generator.setRawTraits(neko.seedOf(2), duplicate);
        generator.setRawTraits(neko.seedOf(3), duplicate);
        vm.prank(ALICE);
        neko.merge(2, 3);
        uint16 historicalRoot = neko.currentRoot(2);

        vm.prank(ALICE);
        neko.mutate(1, 2, 0x0008);

        assertEq(neko.mutationCount(2), 0, "fusion burn retained mutation count");
        assertEq(neko.duplicateMergeCount(2), 0, "fusion burn retained duplicate count");
        assertEq(neko.currentRoot(2), historicalRoot, "fusion burn erased ancestry root");
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        neko.fusionMass(2);
        assertEq(neko.fusionMass(1), 3, "survivor did not absorb the consumed tree's mass");
    }

    function _assertAncestryNode(
        uint16 nodeId,
        uint16 expectedParentA,
        uint16 expectedParentB,
        NekoPFP.FusionAction expectedAction,
        uint16 expectedMask,
        string memory reason
    ) private view {
        (uint16 parentA, uint16 parentB, NekoPFP.FusionAction action, uint16 mutationMask) =
            neko.ancestryNode(nodeId);
        if (
            parentA != expectedParentA || parentB != expectedParentB || action != expectedAction
                || mutationMask != expectedMask
        ) {
            revert(reason);
        }
    }
}
