// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {NekoPFP} from "../src/NekoPFP.sol";
import {NekoTestBase} from "./NekoTestBase.sol";
import {IERC721A} from "erc721a/IERC721A.sol";
import {ICreatorToken, ITransferValidator} from "../src/seadrop/TransferValidation.sol";

interface IRegistry {
    function createList(string calldata name) external returns (uint120);
    function addAccountToAuthorizers(uint120 listId, address account) external;
    function applyListToCollection(address collection, uint120 listId) external;
    function beforeAuthorizedTransfer(address token, uint256 tokenId) external;
    function afterAuthorizedTransfer(address token, uint256 tokenId) external;
}

contract TransferValidationTest is NekoTestBase {
    address internal constant VALIDATOR = 0xA000027A9B2802E1ddf7000061001e5c005A0000;
    address internal constant OPERATOR = address(0xCA11);
    address internal constant AUTHORIZER = address(0xA770);
    IRegistry internal registry = IRegistry(VALIDATOR);

    function setUp() public override {
        super.setUp();
        // Base block 50972204. Constructor state is replaced with a local test list below.
        string memory encoded = vm.readFile("test/fixtures/TransferValidator.hex");
        bytes memory code = vm.parseBytes(LibString.slice(encoded, 0, bytes(encoded).length - 1));
        assertEq(
            keccak256(code), 0xc7dfe8ae4da5613f6406eab346f0808ee2322316f44d186136c830a71491366c
        );
        vm.etch(VALIDATOR, code);
        uint120 listId = registry.createList("Neko test authorizer");
        registry.addAccountToAuthorizers(listId, AUTHORIZER);
        registry.applyListToCollection(address(neko), listId);
        neko.setTransferValidator(VALIDATOR);
        vm.prank(SEA_DROP);
        neko.mintSeaDrop(ALICE, 3);
    }

    function testInterfaceAndOwnerControls() public {
        assertTrue(neko.supportsInterface(type(ICreatorToken).interfaceId));
        (bytes4 selector, bool isView) = neko.getTransferValidationFunction();
        assertEq(selector, ITransferValidator.validateTransfer.selector);
        assertTrue(isView);
        vm.prank(ALICE);
        vm.expectRevert(Ownable.Unauthorized.selector);
        neko.setTransferValidator(address(0));
        vm.expectRevert(NekoPFP.InvalidTransferValidator.selector);
        neko.setTransferValidator(BOB);
        assertEq(neko.getTransferValidator(), VALIDATOR);
    }

    function testOwnerWalletTransfersNeedNoRoyaltyAuthorization() public {
        string memory uri = neko.tokenURI(1);
        vm.prank(ALICE);
        neko.transferFrom(ALICE, BOB, 1);
        assertEq(neko.ownerOf(1), BOB);
        assertEq(neko.tokenURI(1), uri);
        // Smart wallets also retain the owner-initiated transfer path.
        vm.etch(BOB, hex"00");
        vm.prank(BOB);
        neko.transferFrom(BOB, ALICE, 1);
        assertEq(neko.ownerOf(1), ALICE);
    }

    function testApprovedOperatorNeedsAuthorizationForEachToken() public {
        vm.prank(ALICE);
        neko.setApprovalForAll(OPERATOR, true);
        vm.prank(OPERATOR);
        vm.expectRevert(
            bytes4(keccak256("StrictAuthorizedTransferSecurityRegistry__UnauthorizedTransfer()"))
        );
        neko.transferFrom(ALICE, BOB, 1);
        vm.prank(AUTHORIZER);
        registry.beforeAuthorizedTransfer(address(neko), 1);
        vm.prank(OPERATOR);
        vm.expectRevert(
            bytes4(keccak256("StrictAuthorizedTransferSecurityRegistry__UnauthorizedTransfer()"))
        );
        neko.transferFrom(ALICE, BOB, 2);
        vm.prank(OPERATOR);
        neko.safeTransferFrom(ALICE, BOB, 1);
        assertEq(neko.ownerOf(1), BOB);
        assertEq(neko.ownerOf(2), ALICE);
        vm.prank(AUTHORIZER);
        registry.afterAuthorizedTransfer(address(neko), 1);
        vm.prank(BOB);
        neko.setApprovalForAll(OPERATOR, true);
        vm.prank(OPERATOR);
        vm.expectRevert(
            bytes4(keccak256("StrictAuthorizedTransferSecurityRegistry__UnauthorizedTransfer()"))
        );
        neko.transferFrom(BOB, ALICE, 1);
    }

    function testUnauthorizedAccountCannotAuthorizeTransfers() public {
        vm.prank(OPERATOR);
        vm.expectRevert(
            bytes4(
                keccak256("StrictAuthorizedTransferSecurityRegistry__CallerIsNotValidAuthorizer()")
            )
        );
        registry.beforeAuthorizedTransfer(address(neko), 1);
    }

    function testFusionSkipsValidationAndClearsConsumedState() public {
        _setRevealed();
        generator.setRawTraits(neko.tokenSeed(1), _baseTraits(5, 1));
        generator.setRawTraits(neko.tokenSeed(2), _baseTraits(5, 1));
        generator.setRawTraits(neko.tokenSeed(3), _baseTraits(7, 1));
        vm.etch(VALIDATOR, hex"60006000fd");
        vm.prank(ALICE);
        neko.merge(1, 2);
        vm.prank(ALICE);
        neko.mutate(1, 3, 0x0008);
        assertEq(neko.totalSupply(), 1);
        assertEq(neko.fusionMass(1), 3);
        assertEq(neko.duplicateMergeCount(1), 1);
        assertEq(neko.mutationCount(1), 1);
        assertEq(neko.tokenSeed(2), 0);
        assertEq(neko.tokenSeed(3), 0);
        vm.expectRevert(IERC721A.URIQueryForNonexistentToken.selector);
        neko.tokenData(2);
        (uint256 minted, uint256 total, uint256 maximum) = neko.getMintStats(ALICE);
        assertEq(minted, 3);
        assertEq(total, 3);
        assertEq(maximum, INTENDED_SUPPLY);
    }

    function testMintSkipsValidationAndOwnerCanDisableValidator() public {
        vm.etch(VALIDATOR, hex"60006000fd");
        vm.prank(SEA_DROP);
        neko.mintSeaDrop(ALICE, 2);
        assertEq(neko.totalSupply(), 5);
        neko.setTransferValidator(address(0));
        vm.prank(ALICE);
        neko.approve(OPERATOR, 1);
        vm.prank(OPERATOR);
        neko.transferFrom(ALICE, BOB, 1);
        assertEq(neko.ownerOf(1), BOB);
    }
}
