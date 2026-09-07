// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {MewsRenderer} from "../src/MewsRenderer.sol";
import {MewsSeaDrop} from "../src/MewsSeaDrop.sol";
import {ISeaDrop} from "../src/seadrop/SeaDropInterfaces.sol";
import {ICreatorToken, ITransferValidator} from "../src/seadrop/TransferValidation.sol";

interface IRegistry {
    function createList(string calldata name) external returns (uint120);
    function addAccountToAuthorizers(uint120 listId, address account) external;
    function applyListToCollection(address collection, uint120 listId) external;
    function beforeAuthorizedTransfer(address token, uint256 tokenId) external;
    function afterAuthorizedTransfer(address token, uint256 tokenId) external;
}

contract TransferValidationTest is Test {
    address internal constant VALIDATOR = 0xA000027A9B2802E1ddf7000061001e5c005A0000;
    address internal constant DROP = address(0x5EA);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant OPERATOR = address(0xCA11);
    address internal constant AUTHORIZER = address(0xA770);
    IRegistry internal registry = IRegistry(VALIDATOR);
    MewsSeaDrop internal mews;

    function setUp() public {
        // Base block 50972204. Constructor state is replaced with a local test list below.
        string memory encoded = vm.readFile("test/fixtures/TransferValidator.hex");
        bytes memory code = vm.parseBytes(LibString.slice(encoded, 0, bytes(encoded).length - 1));
        assertEq(
            keccak256(code), 0xc7dfe8ae4da5613f6406eab346f0808ee2322316f44d186136c830a71491366c
        );
        vm.etch(VALIDATOR, code);
        MewsRenderer renderer = MewsRenderer(deployCode("MewsRenderer.sol:MewsRenderer"));
        mews = MewsSeaDrop(
            deployCode(
                "MewsSeaDrop.sol:MewsSeaDrop",
                abi.encode(keccak256("Mews validator test"), renderer, ISeaDrop(DROP))
            )
        );
        uint120 listId = registry.createList("Mews test authorizer");
        registry.addAccountToAuthorizers(listId, AUTHORIZER);
        registry.applyListToCollection(address(mews), listId);
        mews.setTransferValidator(VALIDATOR);
        vm.prank(DROP);
        mews.mintSeaDrop(ALICE, 3);
    }

    function testInterfaceAndOwnerControls() public {
        assertTrue(mews.supportsInterface(type(ICreatorToken).interfaceId));
        (bytes4 selector, bool isView) = mews.getTransferValidationFunction();
        assertEq(selector, ITransferValidator.validateTransfer.selector);
        assertTrue(isView);
        vm.prank(ALICE);
        vm.expectRevert(Ownable.Unauthorized.selector);
        mews.setTransferValidator(address(0));
        vm.expectRevert(MewsSeaDrop.InvalidTransferValidator.selector);
        mews.setTransferValidator(BOB);
        assertEq(mews.getTransferValidator(), VALIDATOR);
    }

    function testOwnerWalletTransfersNeedNoRoyaltyAuthorization() public {
        bytes32 seed = mews.tokenSeed(3);
        vm.prank(ALICE);
        mews.transferFrom(ALICE, BOB, 3);
        assertEq(mews.ownerOf(3), BOB);
        assertEq(mews.tokenSeed(3), seed);
        // Smart wallets also retain the owner-initiated transfer path.
        vm.etch(BOB, hex"00");
        vm.prank(BOB);
        mews.transferFrom(BOB, ALICE, 3);
        assertEq(mews.ownerOf(3), ALICE);
    }

    function testApprovedOperatorNeedsAuthorizationForEachToken() public {
        vm.prank(ALICE);
        mews.setApprovalForAll(OPERATOR, true);
        vm.prank(OPERATOR);
        vm.expectRevert(
            bytes4(keccak256("StrictAuthorizedTransferSecurityRegistry__UnauthorizedTransfer()"))
        );
        mews.transferFrom(ALICE, BOB, 3);
        vm.prank(AUTHORIZER);
        registry.beforeAuthorizedTransfer(address(mews), 3);
        vm.prank(OPERATOR);
        vm.expectRevert(
            bytes4(keccak256("StrictAuthorizedTransferSecurityRegistry__UnauthorizedTransfer()"))
        );
        mews.transferFrom(ALICE, BOB, 4);
        vm.prank(OPERATOR);
        mews.safeTransferFrom(ALICE, BOB, 3);
        assertEq(mews.ownerOf(3), BOB);
        assertEq(mews.ownerOf(4), ALICE);
        vm.prank(AUTHORIZER);
        registry.afterAuthorizedTransfer(address(mews), 3);
        vm.prank(BOB);
        mews.setApprovalForAll(OPERATOR, true);
        vm.prank(OPERATOR);
        vm.expectRevert(
            bytes4(keccak256("StrictAuthorizedTransferSecurityRegistry__UnauthorizedTransfer()"))
        );
        mews.transferFrom(BOB, ALICE, 3);
    }

    function testUnauthorizedAccountCannotAuthorizeTransfers() public {
        vm.prank(OPERATOR);
        vm.expectRevert(
            bytes4(
                keccak256("StrictAuthorizedTransferSecurityRegistry__CallerIsNotValidAuthorizer()")
            )
        );
        registry.beforeAuthorizedTransfer(address(mews), 3);
    }

    function testMintSkipsValidationAndOwnerCanDisableValidator() public {
        vm.etch(VALIDATOR, hex"60006000fd");
        vm.prank(DROP);
        mews.mintSeaDrop(ALICE, 2);
        assertEq(mews.totalSupply(), 7);
        mews.setTransferValidator(address(0));
        vm.prank(ALICE);
        mews.approve(OPERATOR, 3);
        vm.prank(OPERATOR);
        mews.transferFrom(ALICE, BOB, 3);
        assertEq(mews.ownerOf(3), BOB);
    }
}
