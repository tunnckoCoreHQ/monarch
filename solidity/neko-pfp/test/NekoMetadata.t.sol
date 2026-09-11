// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {IERC721A} from "erc721a/IERC721A.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {Ownable} from "solady/auth/Ownable.sol";

import {NekoRenderer} from "../src/NekoRenderer.sol";
import {NekoPFP} from "../src/NekoPFP.sol";
import {NekoArt} from "../src/NekoArt.sol";
import {NekoTestBase, TestableNekoPFP} from "./NekoTestBase.sol";

contract NekoMetadataTest is NekoTestBase {
    event GenesisSeedRevealed(bytes32 indexed genesisSeed);
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);

    function testConstructorPublishesCommittedCollectionMetadata() public view {
        assertEq(address(neko.renderer()), address(generator), "generator mismatch");
        assertEq(neko.provenanceHash(), _commitment(GENESIS_SEED), "commitment mismatch");
        assertEq(neko.maxSupply(), INTENDED_SUPPLY, "max supply mismatch");
        assertEq(neko.MAX_SUPPLY(), INTENDED_SUPPLY, "intended supply mismatch");
        assertEq(neko.PRIMARY_COLOR_QUOTA(), PRIMARY_COLOR_QUOTA, "primary color quota mismatch");
        assertTrue(
            LibString.startsWith(
                neko.contractURI(),
                'data:application/json;utf8,{"name":"0xNeko PFP","description":"Fully on-chain, pixel-perfect generative 0xNeko SVG art.","image":"data:image/svg+xml;base64,'
            ),
            "collection metadata mismatch"
        );
    }

    function testUnrevealedTokenUsesPlaceholderAndHasNoSeed() public {
        _mint(ALICE, 1);

        assertEq(neko.tokenSeed(1), 0, "unrevealed token exposed a seed");
        string memory placeholder = _decodeJson(neko.tokenURI(1));
        assertTrue(
            LibString.contains(placeholder, '"name":"0xNeko PFP #1 - Unrevealed"'),
            "placeholder name mismatch"
        );
        assertTrue(
            LibString.contains(placeholder, '"image":"data:image/svg+xml;base64,'),
            "placeholder image is not embedded"
        );
        assertTrue(
            LibString.contains(placeholder, '{"trait_type":"Status","value":"Unrevealed"}'),
            "placeholder status mismatch"
        );

        vm.expectRevert(NekoArt.GenesisSeedNotRevealed.selector);
        neko.tokenData(1);
    }

    function testNonexistentTokenMetadataAlwaysRevertsAndSeedStaysZero() public {
        vm.expectRevert(IERC721A.URIQueryForNonexistentToken.selector);
        neko.tokenURI(1);
        vm.expectRevert(IERC721A.URIQueryForNonexistentToken.selector);
        neko.tokenData(1);

        _setRevealed();

        assertEq(neko.tokenSeed(1), 0, "unminted token received a seed");
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
            abi.encodeWithSelector(NekoArt.MintNotComplete.selector, 0, INTENDED_SUPPLY)
        );
        neko.reveal(GENESIS_SEED);
    }

    function testRevealRequiresExactLifetimeMintBoundary() public {
        _mint(ALICE, INTENDED_SUPPLY - 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                NekoArt.MintNotComplete.selector, INTENDED_SUPPLY - 1, INTENDED_SUPPLY
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
                NekoArt.GenesisSeedCommitmentMismatch.selector,
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
        assertTrue(neko.tokenSeed(1) != 0, "revealed token seed is zero");
    }

    function testRevealCannotRunTwice() public {
        _mint(ALICE, INTENDED_SUPPLY);
        neko.reveal(GENESIS_SEED);

        vm.expectRevert(NekoArt.GenesisSeedAlreadyRevealed.selector);
        neko.reveal(GENESIS_SEED);
    }

    function testRevealAcceptsCommittedZeroSeed() public {
        TestableNekoPFP zeroSeedNeko =
            _deploy(NekoRenderer(address(generator)), _commitment(bytes32(0)));
        vm.prank(SEA_DROP);
        zeroSeedNeko.mintSeaDrop(ALICE, INTENDED_SUPPLY);

        zeroSeedNeko.reveal(bytes32(0));

        assertTrue(zeroSeedNeko.revealed(), "zero seed commitment did not reveal");
        assertEq(zeroSeedNeko.genesisSeed(), bytes32(0), "revealed zero seed changed");
        assertTrue(zeroSeedNeko.tokenSeed(1) != 0, "zero genesis seed produced zero token seed");
    }

    function testRevealedMetadataResolvesTraitsMassAndTokenUri() public {
        _setRevealed();
        _mint(ALICE, 1);
        uint256 seed = neko.tokenSeed(1);
        NekoRenderer.Traits memory expectedTraits = _baseTraits(7, 3);
        generator.setRawTraits(seed, expectedTraits);

        NekoRenderer.TokenData memory data = neko.tokenData(1);
        string memory expectedTokenURI = generator.tokenURI(1, data);

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
        uint256 seedBefore = neko.tokenSeed(1);
        bytes32 metadataBefore = keccak256(bytes(neko.tokenURI(1)));

        vm.prank(ALICE);
        neko.transferFrom(ALICE, BOB, 1);

        assertEq(neko.ownerOf(1), BOB, "transfer owner mismatch");
        assertEq(neko.tokenSeed(1), seedBefore, "transfer changed token seed");
        assertEq(
            keccak256(bytes(neko.tokenURI(1))), metadataBefore, "transfer changed token metadata"
        );
    }

    function testFusionBurnRemovesTokenMetadataAndPublicSeed() public {
        _setRevealed();
        _mint(ALICE, 2);
        NekoRenderer.Traits memory duplicate = _baseTraits(5, 1);
        generator.setRawTraits(neko.tokenSeed(1), duplicate);
        generator.setRawTraits(neko.tokenSeed(2), duplicate);
        assertTrue(neko.tokenSeed(2) != 0, "revealed token has no seed before burn");

        vm.prank(ALICE);
        neko.merge(1, 2);

        assertEq(neko.tokenSeed(2), 0, "burned token retained a seed");
        vm.expectRevert(IERC721A.URIQueryForNonexistentToken.selector);
        neko.tokenURI(2);
        vm.expectRevert(IERC721A.URIQueryForNonexistentToken.selector);
        neko.tokenData(2);
    }

    function testMintingCannotExceedFixedSupply() public {
        _mint(ALICE, INTENDED_SUPPLY);

        vm.prank(SEA_DROP);
        vm.expectRevert(NekoArt.SupplyExceeded.selector);
        neko.mintSeaDrop(ALICE, 1);
    }

    function _decodeJson(string memory uri) private pure returns (string memory) {
        return string(Base64.decode(LibString.slice(uri, 29)));
    }
}
