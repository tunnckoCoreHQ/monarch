// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

// Burn, liveness, block fields and the packed-width limits.
// solhint-disable avoid-low-level-calls

import {GlyphKernel} from "../src/GlyphKernel.sol";
import {GlyphKernelBase} from "./GlyphKernelBase.t.sol";

contract GlyphKernelLifecycleTest is GlyphKernelBase {
    // ── burn ──────────────────────────────────────────────────────

    function test_burn_lifecycle() public {
        vm.roll(100);
        (uint256 id,) = _inscribe(alice, alice, "ashes");
        _transfer(alice, bob, _one(id));

        vm.roll(300);
        vm.expectEmit(true, true, true, true);
        emit GlyphTransfer(id, bob, address(0));
        vm.prank(bob);
        kernel.burn(id);

        // the slot stays, the owner is gone
        assertTrue(kernel.exists(id));
        assertTrue(kernel.isBurned(id));
        assertTrue(kernel.isBurnt(id));
        assertFalse(kernel.isAlive(id));
        assertEq(kernel.ownerOf(id), 0);
        assertFalse(kernel.isOwner(id, bob));
        assertFalse(kernel.isOwner(id, alice));
        assertFalse(kernel.isOwner(id, address(0)));
        assertFalse(kernel.isOwner(id, uint256(0)));
        assertTrue(kernel.isCreator(id, alice));
        assertEq(kernel.glyphNumber(id), 1);
        assertEq(kernel.createdBlock(id), 100);
        assertEq(kernel.ownerSinceBlock(id), 300, "burn block");
        assertEq(kernel.transferCount(id), 2);

        assertEq(kernel.glyphCount(), 1);
        assertEq(kernel.burnCount(), 1);
        assertEq(kernel.totalInscribedSize(), 5, "size stays counted");

        // the creator cannot re-inscribe the same bytes
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.AlreadyInscribed.selector, id));
        kernel.inscribe(alice, "ashes");
    }

    function test_burn_everyTransferPathReverts() public {
        (uint256 id,) = _inscribe(alice, alice, "ashes");
        vm.prank(alice);
        kernel.burn(id);

        bytes memory burnedErr = abi.encodeWithSelector(GlyphKernel.Burned.selector, id);
        uint256 deadline = block.timestamp + 1 days;
        // signed before the burn, stale anyway; `Burned` comes before the signature check
        bytes memory sig = hex"00";

        vm.prank(alice);
        _expectRevertCall(_transferCalldata(bob, _one(id)), burnedErr);
        vm.prank(alice);
        vm.expectRevert(burnedErr);
        kernel.transfer(bob, id);
        vm.prank(alice);
        vm.expectRevert(burnedErr);
        kernel.transfer(bob, _one(id));
        vm.expectRevert(burnedErr);
        kernel.transferWithSig(alice, bob, id, deadline, sig);
        vm.expectRevert(burnedErr);
        kernel.transferWithAuth(alice, bob, id, deadline, sig);
        vm.expectRevert(burnedErr);
        kernel.transferWithSig(alice, bob, _one(id), deadline, sig);
        vm.expectRevert(burnedErr);
        kernel.transferWithAuth(alice, bob, _one(id), deadline, sig);

        // burning twice, by anyone
        vm.prank(alice);
        vm.expectRevert(burnedErr);
        kernel.burn(id);
        vm.prank(bob);
        _expectRevertCall(_burnCalldata(_one(id)), burnedErr);

        // `Burned` wins over `Unauthorized`, `address(0)` included
        vm.prank(address(0));
        vm.expectRevert(burnedErr);
        kernel.transfer(bob, id);
    }

    function test_burn_reverts() public {
        (uint256 id,) = _inscribe(alice, alice, "mine");
        uint256 ghost = kernel.glyphId(alice, "ghost");

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.Unauthorized.selector));
        kernel.burn(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.NotInscribed.selector, ghost));
        kernel.burn(ghost);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidCalldata.selector));
        kernel.burn(new uint256[](0));

        // raw: no ids, misaligned ids
        vm.prank(alice);
        _expectRevertCall(hex"04", abi.encodeWithSelector(GlyphKernel.InvalidCalldata.selector));
        vm.prank(alice);
        _expectRevertCall(
            abi.encodePacked(bytes1(0x04), uint136(id)),
            abi.encodeWithSelector(GlyphKernel.InvalidCalldata.selector)
        );
        vm.prank(alice);
        _expectRevertCall(
            abi.encodePacked(bytes1(0x04), id, bytes1(0x00)),
            abi.encodeWithSelector(GlyphKernel.InvalidCalldata.selector)
        );

        assertTrue(kernel.isAlive(id));
        assertEq(kernel.burnCount(), 0);
    }

    function test_burn_batchRawMatchesAbi() public {
        GlyphKernel twin = new GlyphKernel();
        uint256[] memory ids = _inscribeBatch(alice, alice, _contents("a", "b", "c"));
        vm.prank(alice);
        twin.inscribe(alice, _contents("a", "b", "c"));

        for (uint256 i = 0; i < ids.length; ++i) {
            vm.expectEmit(true, true, true, true);
            emit GlyphTransfer(ids[i], alice, address(0));
        }
        _burn(alice, ids);

        for (uint256 i = 0; i < ids.length; ++i) {
            vm.expectEmit(true, true, true, true, address(twin));
            emit GlyphTransfer(ids[i], alice, address(0));
        }
        vm.prank(alice);
        twin.burn(ids);

        for (uint256 i = 0; i < ids.length; ++i) {
            assertEq(twin.glyphs(ids[i]), kernel.glyphs(ids[i]));
            assertTrue(kernel.isBurned(ids[i]));
        }
        assertEq(twin.stats(), kernel.stats());
        assertEq(kernel.burnCount(), 3);
        assertEq(kernel.glyphCount(), 3);
    }

    function test_burn_batchIsAtomic() public {
        uint256[] memory ids = new uint256[](2);
        (ids[0],) = _inscribe(alice, alice, "mine");
        (ids[1],) = _inscribe(bob, bob, "not mine");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.Unauthorized.selector));
        kernel.burn(ids);

        assertTrue(kernel.isAlive(ids[0]));
        assertTrue(kernel.isAlive(ids[1]));
        assertEq(kernel.burnCount(), 0);
    }

    function test_burn_invalidatesSignatures() public {
        (uint256 id,) = _inscribe(alice, alice, "listed then burned");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signTransfer(aliceKey, id, bob, deadline);

        vm.prank(alice);
        kernel.burn(id);

        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.Burned.selector, id));
        kernel.transferWithSig(alice, bob, id, deadline, sig);
    }

    // ── isAlive ───────────────────────────────────────────────────

    function test_isAlive_overloads() public {
        uint256[] memory ids = new uint256[](3);
        (ids[0],) = _inscribe(alice, alice, "alive");
        (ids[1],) = _inscribe(alice, alice, "burned");
        ids[2] = kernel.glyphId(alice, "unknown");
        vm.prank(alice);
        kernel.burn(ids[1]);

        assertTrue(kernel.isAlive(ids[0]));
        assertFalse(kernel.isAlive(ids[1]));
        assertFalse(kernel.isAlive(ids[2]));

        bool[] memory alive = kernel.isAlive(ids);
        assertEq(alive.length, 3);
        assertTrue(alive[0]);
        assertFalse(alive[1]);
        assertFalse(alive[2]);

        assertEq(kernel.isAlive(new uint256[](0)).length, 0);
    }

    // ── block fields ──────────────────────────────────────────────

    function test_blocks_relativeToDeploy() public {
        vm.roll(1_000_000);
        GlyphKernel late = new GlyphKernel();
        assertEq(late.DEPLOY_BLOCK(), 1_000_000);

        vm.prank(alice);
        (uint256 id,) = late.inscribe(alice, "late");
        assertEq(late.createdBlock(id), 1_000_000);
        assertEq(late.ownerSinceBlock(id), 1_000_000);
        assertEq((late.glyphs(id) >> CREATED_BLOCK_SHIFT) & ((1 << 31) - 1), 0, "stored relative");

        vm.roll(1_000_000 + 5);
        vm.prank(alice);
        late.transfer(bob, id);
        assertEq(late.createdBlock(id), 1_000_000);
        assertEq(late.ownerSinceBlock(id), 1_000_005);
    }

    function test_blocks_wrapAt31Bits() public {
        uint256 deploy = kernel.DEPLOY_BLOCK();

        vm.roll(deploy + (1 << 31) + 7);
        (uint256 id,) = _inscribe(alice, alice, "far future");

        assertEq(kernel.createdBlock(id), deploy + 7, "wrapped modulo 2^31");
        assertEq(kernel.ownerSinceBlock(id), deploy + 7);
        assertTrue(kernel.isOwner(id, alice));
    }

    // ── packed-width limits ───────────────────────────────────────

    function test_transferCountOverflow() public {
        (uint256 id,) = _inscribe(alice, alice, "well travelled");
        uint256 word = kernel.glyphs(id);
        word |= TRANSFER_COUNT_MAX << TRANSFER_COUNT_SHIFT;
        vm.store(address(kernel), _glyphSlot(id), bytes32(word));
        assertEq(kernel.transferCount(id), TRANSFER_COUNT_MAX);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.TransferCountOverflow.selector, id));
        kernel.transfer(bob, id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.TransferCountOverflow.selector, id));
        kernel.burn(id);
        assertTrue(kernel.isOwner(id, alice));

        // one below max: the last move is allowed and lands exactly on max
        word = (word & ~(TRANSFER_COUNT_MAX << TRANSFER_COUNT_SHIFT))
            | ((TRANSFER_COUNT_MAX - 1) << TRANSFER_COUNT_SHIFT);
        vm.store(address(kernel), _glyphSlot(id), bytes32(word));
        vm.prank(alice);
        kernel.transfer(bob, id);
        assertEq(kernel.transferCount(id), TRANSFER_COUNT_MAX);
        assertTrue(kernel.isOwner(id, bob));
    }

    function test_fieldsDoNotBleed() public {
        // max out every non-owner field and check the getters decode cleanly
        (uint256 id,) = _inscribe(alice, alice, "packed");
        uint256 word = _ownerId(alice, id) | (NUMBER_MAX << NUMBER_SHIFT)
            | (((1 << 31) - 1) << CREATED_BLOCK_SHIFT)
            | (((1 << 31) - 1) << OWNER_SINCE_BLOCK_SHIFT)
            | ((TRANSFER_COUNT_MAX - 1) << TRANSFER_COUNT_SHIFT) | EXISTS_FLAG;
        vm.store(address(kernel), _glyphSlot(id), bytes32(word));

        assertEq(kernel.ownerOf(id), _ownerId(alice, id));
        assertEq(kernel.glyphNumber(id), NUMBER_MAX);
        assertEq(kernel.createdBlock(id), kernel.DEPLOY_BLOCK() + (1 << 31) - 1);
        assertEq(kernel.ownerSinceBlock(id), kernel.DEPLOY_BLOCK() + (1 << 31) - 1);
        assertEq(kernel.transferCount(id), TRANSFER_COUNT_MAX - 1);
        assertTrue(kernel.isAlive(id));

        // a move keeps number / created block / flags, refreshes owner-since, bumps count
        vm.roll(kernel.DEPLOY_BLOCK() + 42);
        vm.prank(alice);
        kernel.burn(id);
        assertEq(kernel.ownerOf(id), 0);
        assertEq(kernel.glyphNumber(id), NUMBER_MAX);
        assertEq(kernel.createdBlock(id), kernel.DEPLOY_BLOCK() + (1 << 31) - 1);
        assertEq(kernel.ownerSinceBlock(id), kernel.DEPLOY_BLOCK() + 42);
        assertEq(kernel.transferCount(id), TRANSFER_COUNT_MAX);
        assertTrue(kernel.isBurned(id));
        assertEq(kernel.burnCount(), 1);
    }

    function test_stats_burnCountSitsAboveSize() public {
        // size and glyph count maxed, then burns must only touch their field
        uint256 word = NUMBER_MAX | (uint256(type(uint64).max) << TOTAL_SIZE_SHIFT);
        vm.store(address(kernel), bytes32(0), bytes32(word));
        assertEq(kernel.glyphCount(), NUMBER_MAX);
        assertEq(kernel.totalInscribedSize(), type(uint64).max);
        assertEq(kernel.burnCount(), 0);

        // an inscribed glyph to burn, planted directly so the counter is untouched
        uint256 id = kernel.glyphId(alice, "planted");
        vm.store(address(kernel), _glyphSlot(id), bytes32(_ownerId(alice, id) | EXISTS_FLAG));
        vm.prank(alice);
        kernel.burn(id);

        assertEq(kernel.burnCount(), 1);
        assertEq(kernel.glyphCount(), NUMBER_MAX);
        assertEq(kernel.totalInscribedSize(), type(uint64).max);
    }
}
