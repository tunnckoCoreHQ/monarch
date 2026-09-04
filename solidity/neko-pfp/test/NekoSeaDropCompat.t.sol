// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {Ownable} from "solady/auth/Ownable.sol";

import {ERC721SeaDropCompat} from "../src/seadrop/ERC721SeaDropCompat.sol";
import {ISeaDrop} from "../src/seadrop/ISeaDrop.sol";
import {
    IERC2981,
    ISeaDropTokenContractMetadata
} from "../src/seadrop/ISeaDropTokenContractMetadata.sol";
import {INonFungibleSeaDropToken} from "../src/seadrop/INonFungibleSeaDropToken.sol";
import {NekoPFP} from "../src/NekoPFP.sol";
import {
    AllowListData,
    PublicDrop,
    SignedMintValidationParams,
    TokenGatedDropStage
} from "../src/seadrop/SeaDropStructs.sol";
import {MockSeaDrop} from "./mocks/MockSeaDrop.sol";
import {NekoTestBase} from "./NekoTestBase.sol";

contract NekoSeaDropCompatTest is NekoTestBase {
    /// @dev The interface id computed off-chain from the exact function selectors of
    ///      `INonFungibleSeaDropToken` as declared in the deployed protocol; SeaDrop
    ///      checks this value in its `onlyINonFungibleSeaDropToken` modifier.
    bytes4 private constant NON_FUNGIBLE_SEADROP_INTERFACE_ID = 0x1890fe8e;

    MockSeaDrop internal mockSeaDrop;

    function setUp() public override {
        super.setUp();
        mockSeaDrop = new MockSeaDrop();
        address[] memory allowed = new address[](2);
        allowed[0] = SEA_DROP;
        allowed[1] = address(mockSeaDrop);
        neko.updateAllowedSeaDrop(allowed);
    }

    // ------------------------------------------------------------------
    // ERC-165
    // ------------------------------------------------------------------

    function testInterfaceIdMatchesDeployedSeaDropExpectation() public pure {
        assertEq(
            type(INonFungibleSeaDropToken).interfaceId,
            NON_FUNGIBLE_SEADROP_INTERFACE_ID,
            "recomputed interface id drifted from the deployed SeaDrop expectation"
        );
    }

    function testSupportsInterfaceCoversSeaDropAndErc721AndErc2981() public view {
        assertTrue(
            neko.supportsInterface(type(INonFungibleSeaDropToken).interfaceId),
            "does not advertise INonFungibleSeaDropToken"
        );
        assertTrue(
            neko.supportsInterface(type(ISeaDropTokenContractMetadata).interfaceId),
            "does not advertise ISeaDropTokenContractMetadata"
        );
        assertTrue(
            neko.supportsInterface(type(IERC2981).interfaceId), "does not advertise IERC2981"
        );

        // ERC721A advertises the classic ERC-165, ERC-721, and ERC-721Metadata ids.
        assertTrue(neko.supportsInterface(0x01ffc9a7), "does not advertise ERC-165");
        assertTrue(neko.supportsInterface(0x80ac58cd), "does not advertise ERC-721");
        assertTrue(neko.supportsInterface(0x5b5e139f), "does not advertise ERC-721 Metadata");

        // ERC-4906, so marketplaces watch the MetadataUpdate events for reveal and fusion.
        assertTrue(neko.supportsInterface(0x49064906), "does not advertise ERC-4906");

        assertFalse(neko.supportsInterface(0xffffffff), "answered true for reserved bad id");
        assertFalse(neko.supportsInterface(0xdeadbeef), "answered true for random id");
    }

    // ------------------------------------------------------------------
    // getMintStats
    // ------------------------------------------------------------------

    function testMintStatsReflectPerWalletAndCollectionCounters() public {
        (uint256 minted, uint256 total, uint256 cap) = neko.getMintStats(ALICE);
        assertEq(minted, 0, "initial minter count");
        assertEq(total, 0, "initial total minted");
        assertEq(cap, INTENDED_SUPPLY, "initial max supply");

        _mint(ALICE, 3);
        _mint(BOB, 2);

        (minted, total, cap) = neko.getMintStats(ALICE);
        assertEq(minted, 3, "alice minted count");
        assertEq(total, 5, "total minted");
        assertEq(cap, INTENDED_SUPPLY, "max supply unchanged");

        (minted,,) = neko.getMintStats(BOB);
        assertEq(minted, 2, "bob minted count");
    }

    // ------------------------------------------------------------------
    // Allowed SeaDrop registry
    // ------------------------------------------------------------------

    function testUpdateAllowedSeaDropReplacesTheSet() public {
        address newSeaDrop = address(0xBEEF);
        address[] memory replacement = new address[](1);
        replacement[0] = newSeaDrop;

        neko.updateAllowedSeaDrop(replacement);

        vm.prank(newSeaDrop);
        neko.mintSeaDrop(ALICE, 1);
        assertEq(neko.ownerOf(1), ALICE, "new seadrop cannot mint");

        vm.prank(address(mockSeaDrop));
        vm.expectRevert(INonFungibleSeaDropToken.OnlyAllowedSeaDrop.selector);
        neko.mintSeaDrop(ALICE, 1);
    }

    function testUpdateAllowedSeaDropRejectsNonOwner() public {
        address[] memory replacement = new address[](0);
        vm.prank(BOB);
        vm.expectRevert(Ownable.Unauthorized.selector);
        neko.updateAllowedSeaDrop(replacement);
    }

    // ------------------------------------------------------------------
    // Passthroughs to the SeaDrop protocol
    // ------------------------------------------------------------------

    function testPassthroughsForwardTheCallVerbatimAsTheTokenContract() public {
        PublicDrop memory publicDrop = PublicDrop({
            mintPrice: 0.01 ether,
            startTime: uint48(block.timestamp + 60),
            endTime: uint48(block.timestamp + 3600),
            maxTotalMintableByWallet: 3,
            feeBps: 500,
            restrictFeeRecipients: true
        });
        neko.updatePublicDrop(address(mockSeaDrop), publicDrop);

        assertEq(
            mockSeaDrop.callerOf(ISeaDrop.updatePublicDrop.selector),
            address(neko),
            "public drop caller was not the token"
        );
        assertEq(
            keccak256(mockSeaDrop.dataOf(ISeaDrop.updatePublicDrop.selector)),
            keccak256(abi.encode(publicDrop)),
            "public drop payload was not forwarded verbatim"
        );

        AllowListData memory allowList = AllowListData({
            merkleRoot: keccak256("root"),
            publicKeyURIs: new string[](0),
            allowListURI: "ipfs://allowlist"
        });
        neko.updateAllowList(address(mockSeaDrop), allowList);
        assertEq(
            mockSeaDrop.callerOf(ISeaDrop.updateAllowList.selector),
            address(neko),
            "allow list caller mismatch"
        );

        neko.updateDropURI(address(mockSeaDrop), "ipfs://drop");
        assertEq(
            keccak256(mockSeaDrop.dataOf(ISeaDrop.updateDropURI.selector)),
            keccak256(abi.encode("ipfs://drop")),
            "drop uri payload mismatch"
        );

        neko.updateCreatorPayoutAddress(address(mockSeaDrop), BOB);
        neko.updateAllowedFeeRecipient(address(mockSeaDrop), ALICE, true);
        neko.updatePayer(address(mockSeaDrop), ALICE, true);
        assertEq(
            keccak256(mockSeaDrop.dataOf(ISeaDrop.updatePayer.selector)),
            keccak256(abi.encode(ALICE, true)),
            "payer payload mismatch"
        );
    }

    function testPassthroughsRejectDisallowedSeaDrop() public {
        PublicDrop memory publicDrop;
        vm.expectRevert(INonFungibleSeaDropToken.OnlyAllowedSeaDrop.selector);
        neko.updatePublicDrop(address(0xC0DE), publicDrop);

        vm.expectRevert(INonFungibleSeaDropToken.OnlyAllowedSeaDrop.selector);
        neko.updateDropURI(address(0xC0DE), "ipfs://drop");
    }

    function testPassthroughsRejectNonOwner() public {
        PublicDrop memory publicDrop;
        vm.prank(BOB);
        vm.expectRevert(Ownable.Unauthorized.selector);
        neko.updatePublicDrop(address(mockSeaDrop), publicDrop);
    }

    // ------------------------------------------------------------------
    // Contract metadata setters
    // ------------------------------------------------------------------

    function testSetMaxSupplyGuardsAgainstShrinkingBelowMintedAndUint64() public {
        _mint(ALICE, 3);

        vm.expectRevert(
            abi.encodeWithSelector(
                ISeaDropTokenContractMetadata.NewMaxSupplyCannotBeLessThenTotalMinted.selector, 2, 3
            )
        );
        neko.setMaxSupply(2);

        vm.expectRevert(
            abi.encodeWithSelector(
                ISeaDropTokenContractMetadata.CannotExceedMaxSupplyOfUint64.selector,
                uint256(type(uint64).max) + 1
            )
        );
        neko.setMaxSupply(uint256(type(uint64).max) + 1);

        neko.setMaxSupply(INTENDED_SUPPLY);
        assertEq(neko.maxSupply(), INTENDED_SUPPLY, "max supply not updated");
    }

    function testProvenanceHashHoldsTheGenesisSeedCommitmentFromDeploy() public view {
        assertEq(
            neko.provenanceHash(),
            _commitment(GENESIS_SEED),
            "provenance hash does not hold the deploy-time seed commitment"
        );
    }

    function testSetProvenanceHashAlwaysRevertsBecauseCommitmentIsImmutable() public {
        // Before any mint.
        vm.expectRevert(NekoPFP.ProvenanceHashImmutable.selector);
        neko.setProvenanceHash(keccak256("changed"));

        _mint(ALICE, 1);

        // After minting begins.
        vm.expectRevert(NekoPFP.ProvenanceHashImmutable.selector);
        neko.setProvenanceHash(keccak256("also changed"));

        // The stored commitment is unchanged.
        assertEq(
            neko.provenanceHash(),
            _commitment(GENESIS_SEED),
            "provenance hash drifted after failed setter"
        );
    }

    function testSetBaseAndContractUriEmitAndPersist() public {
        neko.setBaseURI("ipfs://base/");
        assertEq(neko.baseURI(), "ipfs://base/", "base uri not stored");

        neko.setContractURI("ipfs://contract.json");
        assertEq(neko.contractURI(), "ipfs://contract.json", "contract uri not stored");
    }

    // ------------------------------------------------------------------
    // Royalties (ERC-2981)
    // ------------------------------------------------------------------

    function testRoyaltyInfoAppliesBpsToSalePrice() public {
        ISeaDropTokenContractMetadata.RoyaltyInfo memory info =
            ISeaDropTokenContractMetadata.RoyaltyInfo({royaltyAddress: BOB, royaltyBps: 750});
        neko.setRoyaltyInfo(info);

        (address receiver, uint256 amount) = neko.royaltyInfo(0, 1 ether);
        assertEq(receiver, BOB, "royalty receiver mismatch");
        assertEq(amount, 0.075 ether, "royalty amount mismatch");
        assertEq(neko.royaltyAddress(), BOB, "royalty address getter mismatch");
        assertEq(neko.royaltyBasisPoints(), 750, "royalty bps getter mismatch");
    }

    function testSetRoyaltyInfoRejectsInvalidInputs() public {
        ISeaDropTokenContractMetadata.RoyaltyInfo memory zeroReceiver =
            ISeaDropTokenContractMetadata.RoyaltyInfo({royaltyAddress: address(0), royaltyBps: 500});
        vm.expectRevert(ISeaDropTokenContractMetadata.RoyaltyAddressCannotBeZeroAddress.selector);
        neko.setRoyaltyInfo(zeroReceiver);

        ISeaDropTokenContractMetadata.RoyaltyInfo memory tooHigh =
            ISeaDropTokenContractMetadata.RoyaltyInfo({royaltyAddress: BOB, royaltyBps: 10_001});
        vm.expectRevert(
            abi.encodeWithSelector(
                ISeaDropTokenContractMetadata.InvalidRoyaltyBasisPoints.selector, 10_001
            )
        );
        neko.setRoyaltyInfo(tooHigh);
    }
}
