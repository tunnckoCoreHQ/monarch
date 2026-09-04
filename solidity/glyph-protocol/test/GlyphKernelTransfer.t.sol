// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

// solhint-disable avoid-low-level-calls

import {GlyphKernel} from "../src/GlyphKernel.sol";
import {GlyphKernelBase} from "./GlyphKernelBase.t.sol";

contract GlyphKernelTransferTest is GlyphKernelBase {
    // ── transfer ──────────────────────────────────────────────────

    function test_transfer_updatesOwnership() public {
        vm.roll(100);
        (uint256 id,) = _inscribe(alice, alice, "gm");

        vm.roll(200);
        vm.expectEmit(true, true, true, true);
        emit GlyphTransfer(id, alice, bob);
        _transfer(alice, bob, _one(id));

        assertEq(kernel.ownerOf(id), _ownerId(bob, id));
        assertTrue(kernel.isOwner(id, bob));
        assertFalse(kernel.isOwner(id, alice));
        assertTrue(kernel.isCreator(id, alice));
        assertEq(kernel.transferCount(id), 1);
        assertEq(kernel.glyphNumber(id), 1, "number preserved");
        assertEq(kernel.createdBlock(id), 100, "created block preserved");
        assertEq(kernel.ownerSinceBlock(id), 200, "owner-since refreshed");
        assertTrue(kernel.exists(id));
        assertTrue(kernel.isAlive(id));
    }

    function test_transfer_chain() public {
        (uint256 id,) = _inscribe(alice, alice, "gm");
        _transfer(alice, bob, _one(id));
        _transfer(bob, carol, _one(id));

        assertTrue(kernel.isOwner(id, carol));
        assertFalse(kernel.isOwner(id, bob));
        assertFalse(kernel.isOwner(id, alice));
        assertTrue(kernel.isCreator(id, alice));
        assertEq(kernel.transferCount(id), 2);
    }

    function test_transfer_batch() public {
        uint256[] memory ids = new uint256[](3);
        (ids[0],) = _inscribe(alice, alice, "a");
        (ids[1],) = _inscribe(alice, alice, "b");
        (ids[2],) = _inscribe(alice, alice, "c");

        for (uint256 i = 0; i < ids.length; ++i) {
            vm.expectEmit(true, true, true, true);
            emit GlyphTransfer(ids[i], alice, bob);
        }
        _transfer(alice, bob, ids);

        for (uint256 i = 0; i < ids.length; ++i) {
            assertTrue(kernel.isOwner(ids[i], bob));
            assertEq(kernel.transferCount(ids[i]), 1);
        }
    }

    function test_transfer_toSelfBumpsCount() public {
        (uint256 id,) = _inscribe(alice, alice, "gm");
        _transfer(alice, alice, _one(id));

        assertTrue(kernel.isOwner(id, alice));
        assertEq(kernel.transferCount(id), 1);
    }

    function test_transfer_reverts() public {
        (uint256 id,) = _inscribe(alice, alice, "gm");
        uint256 ghost = kernel.glyphId(alice, "ghost");

        vm.prank(bob);
        _expectRevertCall(
            _transferCalldata(carol, _one(id)),
            abi.encodeWithSelector(GlyphKernel.Unauthorized.selector)
        );

        vm.prank(alice);
        _expectRevertCall(
            _transferCalldata(bob, _one(ghost)),
            abi.encodeWithSelector(GlyphKernel.NotInscribed.selector, ghost)
        );

        vm.prank(alice);
        _expectRevertCall(
            _transferCalldata(address(0), _one(id)),
            abi.encodeWithSelector(GlyphKernel.ZeroRecipient.selector)
        );

        vm.prank(alice);
        _expectRevertCall(
            abi.encodePacked(bytes1(0x02), bob),
            abi.encodeWithSelector(GlyphKernel.InvalidCalldata.selector)
        );
        vm.prank(alice);
        _expectRevertCall(
            abi.encodePacked(bytes1(0x02), bob, uint136(id)),
            abi.encodeWithSelector(GlyphKernel.InvalidCalldata.selector)
        );
        vm.prank(alice);
        _expectRevertCall(
            abi.encodePacked(bytes1(0x02), bob, id, bytes1(0x00)),
            abi.encodeWithSelector(GlyphKernel.InvalidCalldata.selector)
        );
    }

    function test_transfer_batchIsAtomic() public {
        uint256[] memory ids = new uint256[](2);
        (ids[0],) = _inscribe(alice, alice, "mine");
        (ids[1],) = _inscribe(bob, bob, "not mine");

        vm.prank(alice);
        _expectRevertCall(
            _transferCalldata(carol, ids), abi.encodeWithSelector(GlyphKernel.Unauthorized.selector)
        );

        assertTrue(kernel.isOwner(ids[0], alice));
        assertTrue(kernel.isOwner(ids[1], bob));
    }

    // ── ABI transfer ──────────────────────────────────────────────

    function test_abiTransfer_matchesRaw() public {
        GlyphKernel twin = new GlyphKernel();
        uint256[] memory ids = _inscribeBatch(alice, alice, _contents("a", "b", "c"));
        vm.prank(alice);
        twin.inscribe(alice, _contents("a", "b", "c"));

        vm.roll(9);
        _transfer(alice, bob, ids);

        for (uint256 i = 0; i < ids.length; ++i) {
            vm.expectEmit(true, true, true, true, address(twin));
            emit GlyphTransfer(ids[i], alice, bob);
        }
        vm.prank(alice);
        twin.transfer(bob, ids);

        for (uint256 i = 0; i < ids.length; ++i) {
            assertEq(twin.glyphs(ids[i]), kernel.glyphs(ids[i]));
        }
    }

    function test_abiTransfer_single() public {
        (uint256 id,) = _inscribe(alice, alice, "gm");

        vm.expectEmit(true, true, true, true);
        emit GlyphTransfer(id, alice, bob);
        vm.prank(alice);
        kernel.transfer(bob, id);

        assertTrue(kernel.isOwner(id, bob));
        assertEq(kernel.transferCount(id), 1);
    }

    function test_abiTransfer_reverts() public {
        (uint256 id,) = _inscribe(alice, alice, "gm");

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.Unauthorized.selector));
        kernel.transfer(carol, _one(id));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.Unauthorized.selector));
        kernel.transfer(carol, id);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidCalldata.selector));
        kernel.transfer(bob, new uint256[](0));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.ZeroRecipient.selector));
        kernel.transfer(address(0), id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.ZeroRecipient.selector));
        kernel.transfer(address(0), _one(id));
    }

    // ── fuzz ──────────────────────────────────────────────────────

    function testFuzz_glyphIdCodec(address creator, bytes calldata content) public view {
        uint256 id = kernel.glyphId(creator, content);
        uint256 contentId = uint256(keccak256(content)) & CONTENT_ID_MASK;

        assertEq(kernel.contentIdOf(id), contentId);
        assertEq(kernel.creatorOf(id), creator == address(0) ? 0 : _creatorId(creator, contentId));
        assertEq(kernel.isCreator(id, creator), creator != address(0));
        assertTrue(kernel.verifyContent(id, content));
    }

    function testFuzz_inscribeContent(bytes calldata content) public {
        vm.assume(content.length <= kernel.MAX_CONTENT_SIZE());

        (uint256 id, bytes32 contentId) = _inscribe(alice, alice, content);

        assertEq(contentId, keccak256(content));
        assertEq(id, _glyphId(alice, content));
        assertTrue(kernel.verifyContent(id, content));
        assertEq(kernel.totalInscribedSize(), content.length);
    }

    function testFuzz_onlyOwnerMatches(address other) public {
        vm.assume(other != alice);
        (uint256 id,) = _inscribe(alice, alice, "gm");

        assertTrue(kernel.isOwner(id, alice));
        assertFalse(kernel.isOwner(id, other));
    }
}
