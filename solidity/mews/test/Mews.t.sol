// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC721A} from "erc721a/IERC721A.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {Mews} from "../src/Mews.sol";
import {MewsArt} from "../src/MewsArt.sol";
import {MewsRenderer} from "../src/MewsRenderer.sol";

contract RejectingReceiver {}

contract ReenteringReceiver {
    Mews private _mews;
    bytes public rejection;

    function begin(Mews mews) external {
        _mews = mews;
        mews.mint(1);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        try _mews.mint(1) {}
        catch (bytes memory reason) {
            rejection = reason;
        }
        return this.onERC721Received.selector;
    }
}

contract MewsTest is Test {
    bytes32 internal constant GENESIS = keccak256("Mews NFT test genesis");
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    MewsRenderer internal renderer;
    Mews internal mews;

    function setUp() public {
        renderer = MewsRenderer(deployCode("MewsRenderer.sol:MewsRenderer"));
        mews = new Mews(GENESIS, renderer);
    }

    function testDeploymentMintsNothing() public view {
        assertEq(mews.name(), "Mews");
        assertEq(mews.symbol(), "MEWS");
        assertEq(mews.totalSupply(), 0);
        assertEq(mews.balanceOf(address(this)), 0);
        assertTrue(mews.supportsInterface(0x80ac58cd));
        assertTrue(mews.supportsInterface(0x5b5e139f));
        assertLe(address(mews).code.length, 24_576);
    }

    function testAnyoneCanBatchMint() public {
        vm.prank(ALICE);
        mews.mint(3);
        assertEq(mews.totalSupply(), 3);
        assertEq(mews.balanceOf(ALICE), 3);
        for (uint256 id = 1; id <= 3; ++id) {
            assertEq(mews.ownerOf(id), ALICE);
            assertEq(mews.tokenSeed(id), mews.mintSeed(ALICE, id));
        }
    }

    function testFullSupplyLimit() public {
        vm.startPrank(ALICE);
        mews.mint(1000);
        assertEq(mews.totalSupply(), 1000);
        assertEq(mews.balanceOf(ALICE), 1000);
        assertEq(mews.ownerOf(1000), ALICE);
        vm.expectRevert(MewsArt.SupplyExceeded.selector);
        mews.mint(1);
        vm.stopPrank();
    }

    function testApprovedTransferPreservesArtAndRawData() public {
        vm.prank(ALICE);
        mews.mint(1);
        string memory uri = mews.tokenURI(1);
        bytes memory raw = abi.encode(mews.tokenData(1));
        vm.prank(ALICE);
        mews.approve(BOB, 1);
        vm.prank(BOB);
        mews.transferFrom(ALICE, BOB, 1);
        assertEq(mews.ownerOf(1), BOB);
        assertEq(mews.tokenURI(1), uri);
        assertEq(abi.encode(mews.tokenData(1)), raw);
    }

    function testNonexistentTokensRejectMetadataAndRawData() public {
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        mews.tokenURI(0);
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        mews.tokenURI(1);
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        mews.tokenData(1);
    }

    function testRejectedReceiverRollsBackMint() public {
        RejectingReceiver receiver = new RejectingReceiver();
        vm.prank(address(receiver));
        vm.expectRevert(IERC721A.TransferToNonERC721ReceiverImplementer.selector);
        mews.mint(1);
        assertEq(mews.totalSupply(), 0);
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        mews.tokenSeed(1);
        vm.prank(ALICE);
        mews.mint(1);
        assertEq(mews.tokenSeed(1), mews.mintSeed(ALICE, 1));
    }

    function testReceiverCannotReenterMint() public {
        ReenteringReceiver receiver = new ReenteringReceiver();
        receiver.begin(mews);
        assertEq(mews.totalSupply(), 1);
        assertEq(mews.ownerOf(1), address(receiver));
        assertEq(receiver.rejection(), abi.encodeWithSelector(ReentrancyGuard.Reentrancy.selector));
    }
}
