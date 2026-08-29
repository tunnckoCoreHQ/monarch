// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {IERC721A} from "erc721a/IERC721A.sol";
import {Ownable} from "solady/auth/Ownable.sol";

import {INekoGenerator} from "../src/INekoGenerator.sol";
import {NekoPFP} from "../src/NekoPFP.sol";
import {NekoTestBase, TestableNekoPFP} from "./NekoTestBase.sol";

contract NekoMetadataTest is NekoTestBase {
    event GenesisSeedRevealed(bytes32 indexed genesisSeed);
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);

    function testConstructorPublishesCommittedCollectionMetadata() public view {
        string memory expectedContractURI = string.concat(
            'data:application/json;utf8,{"name":"Neko","description":"Fully on-chain, pixel-perfect generative 0xNeko SVG art.","image":"',
            generator.generateUnrevealedImageURI(),
            '"}'
        );

        assertEq(address(neko.generator()), address(generator), "generator mismatch");
        assertEq(neko.provenanceHash(), _commitment(GENESIS_SEED), "commitment mismatch");
        assertEq(neko.startBlock(), block.number, "start block mismatch");
        assertTrue(neko.open(), "collection is not open");
        assertEq(neko.maxSupply(), INTENDED_SUPPLY, "max supply mismatch");
        assertEq(neko.INTENDED_SUPPLY(), INTENDED_SUPPLY, "intended supply mismatch");
        assertEq(neko.PRIMARY_COLOR_QUOTA(), PRIMARY_COLOR_QUOTA, "primary color quota mismatch");
        assertEq(neko.contractURI(), expectedContractURI, "contract metadata mismatch");
    }

    function testUnrevealedTokenUsesPlaceholderAndHasNoSeed() public {
        _mint(ALICE, 1);

        assertEq(neko.seedOf(1), 0, "unrevealed token exposed a seed");
        assertEq(
            neko.tokenURI(1),
            generator.generateUnrevealedTokenURI(1),
            "placeholder metadata mismatch"
        );

        vm.expectRevert(NekoPFP.GenesisSeedNotRevealed.selector);
        neko.tokenData(1);
    }

    function testNonexistentTokenMetadataAlwaysRevertsAndSeedStaysZero() public {
        vm.expectRevert(IERC721A.URIQueryForNonexistentToken.selector);
        neko.tokenURI(1);
        vm.expectRevert(IERC721A.URIQueryForNonexistentToken.selector);
        neko.tokenData(1);

        _setRevealed();

        assertEq(neko.seedOf(1), 0, "unminted token received a seed");
        vm.expectRevert(IERC721A.URIQueryForNonexistentToken.selector);
        neko.tokenURI(1);
        vm.expectRevert(IERC721A.URIQueryForNonexistentToken.selector);
        neko.tokenData(1);
    }

    function testDerivedSeedsAreDeterministicAndBoundToSeedAndTokenId() public view {
        uint256 first = neko.deriveTokenSeed(GENESIS_SEED, 1);

        assertEq(neko.deriveTokenSeed(GENESIS_SEED, 1), first, "same input changed token seed");
        assertTrue(
            neko.deriveTokenSeed(GENESIS_SEED, 2) != first, "token id did not affect token seed"
        );
        assertTrue(
            neko.deriveTokenSeed(keccak256("alternate collection seed"), 1) != first,
            "collection seed did not affect token seed"
        );
    }

    function testRevealRequiresCompleteLifetimeMint() public {
        vm.expectRevert(
            abi.encodeWithSelector(NekoPFP.MintNotComplete.selector, 0, INTENDED_SUPPLY)
        );
        neko.reveal(GENESIS_SEED);
    }

    function testRevealRequiresExactLifetimeMintBoundary() public {
        _mint(ALICE, INTENDED_SUPPLY - 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                NekoPFP.MintNotComplete.selector, INTENDED_SUPPLY - 1, INTENDED_SUPPLY
            )
        );
        neko.reveal(GENESIS_SEED);
    }

    function testRevealRejectsNonOwner() public {
        _mint(ALICE, INTENDED_SUPPLY);

        vm.prank(BOB);
        vm.expectRevert(Ownable.Unauthorized.selector);
        neko.reveal(GENESIS_SEED);
    }

    function testRevealRejectsSeedThatDoesNotMatchCommitment() public {
        _mint(ALICE, INTENDED_SUPPLY);
        bytes32 wrongSeed = keccak256("wrong seed");

        vm.expectRevert(
            abi.encodeWithSelector(
                NekoPFP.GenesisSeedCommitmentMismatch.selector,
                _commitment(GENESIS_SEED),
                _commitment(wrongSeed)
            )
        );
        neko.reveal(wrongSeed);
    }

    function testRevealStoresCommittedSeedAfterCompleteMint() public {
        _mint(ALICE, INTENDED_SUPPLY);

        vm.expectEmit(true, false, false, true, address(neko));
        emit GenesisSeedRevealed(GENESIS_SEED);
        vm.expectEmit(false, false, false, true, address(neko));
        emit BatchMetadataUpdate(1, type(uint256).max);
        neko.reveal(GENESIS_SEED);

        assertTrue(neko.revealed(), "collection did not reveal");
        assertEq(neko.genesisSeed(), GENESIS_SEED, "revealed seed mismatch");
        assertTrue(neko.seedOf(1) != 0, "revealed token seed is zero");
    }

    function testRevealCannotRunTwice() public {
        _mint(ALICE, INTENDED_SUPPLY);
        neko.reveal(GENESIS_SEED);

        vm.expectRevert(NekoPFP.GenesisSeedAlreadyRevealed.selector);
        neko.reveal(GENESIS_SEED);
    }

    function testRevealAcceptsCommittedZeroSeed() public {
        TestableNekoPFP zeroSeedNeko = _deploy(generator, _commitment(bytes32(0)));
        vm.prank(SEA_DROP);
        zeroSeedNeko.mintSeaDrop(ALICE, INTENDED_SUPPLY);

        zeroSeedNeko.reveal(bytes32(0));

        assertTrue(zeroSeedNeko.revealed(), "zero seed commitment did not reveal");
        assertEq(zeroSeedNeko.genesisSeed(), bytes32(0), "revealed zero seed changed");
        assertTrue(zeroSeedNeko.seedOf(1) != 0, "zero genesis seed produced zero token seed");
    }

    function testRevealedMetadataResolvesTraitsMassAndTokenUri() public {
        _setRevealed();
        _mint(ALICE, 1);
        uint256 seed = neko.seedOf(1);
        INekoGenerator.RawTraits memory expectedTraits = _baseTraits(7, 3);
        generator.setRawTraits(seed, expectedTraits);

        INekoGenerator.TokenData memory data = neko.tokenData(1);
        string memory expectedTokenURI = generator.generateTokenURI(1, data);

        assertEq(
            keccak256(abi.encode(data.traits)),
            keccak256(abi.encode(expectedTraits)),
            "resolved traits mismatch"
        );
        assertEq(data.fusionMass, 1, "unfused token mass mismatch");
        assertEq(neko.tokenURI(1), expectedTokenURI, "revealed token URI mismatch");
    }

    function testTransferPreservesRevealedSeedAndMetadata() public {
        _setRevealed();
        _mint(ALICE, 1);
        uint256 seedBefore = neko.seedOf(1);
        bytes32 metadataBefore = keccak256(bytes(neko.tokenURI(1)));

        vm.prank(ALICE);
        neko.transferFrom(ALICE, BOB, 1);

        assertEq(neko.ownerOf(1), BOB, "transfer owner mismatch");
        assertEq(neko.seedOf(1), seedBefore, "transfer changed token seed");
        assertEq(
            keccak256(bytes(neko.tokenURI(1))), metadataBefore, "transfer changed token metadata"
        );
    }

    function testFusionBurnRemovesTokenMetadataAndPublicSeed() public {
        _setRevealed();
        _mint(ALICE, 2);
        INekoGenerator.RawTraits memory duplicate = _baseTraits(5, 1);
        generator.setRawTraits(neko.seedOf(1), duplicate);
        generator.setRawTraits(neko.seedOf(2), duplicate);
        assertTrue(neko.seedOf(2) != 0, "revealed token has no seed before burn");

        vm.prank(ALICE);
        neko.merge(1, 2);

        assertEq(neko.seedOf(2), 0, "burned token retained a seed");
        vm.expectRevert(IERC721A.URIQueryForNonexistentToken.selector);
        neko.tokenURI(2);
        vm.expectRevert(IERC721A.URIQueryForNonexistentToken.selector);
        neko.tokenData(2);
    }

    function testIntendedSupplyCannotBeBypassedByIncreasingMaxSupply() public {
        neko.setMaxSupply(INTENDED_SUPPLY + 1);
        _mint(ALICE, INTENDED_SUPPLY);

        vm.prank(SEA_DROP);
        vm.expectRevert(
            abi.encodeWithSelector(NekoPFP.IntendedSupplyExceeded.selector, INTENDED_SUPPLY, 1)
        );
        neko.mintSeaDrop(ALICE, 1);
    }
}
