// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

// solhint-disable avoid-low-level-calls

import {GlyphKernel} from "../src/GlyphKernel.sol";
import {GlyphKernelBase} from "./GlyphKernelBase.t.sol";

contract GlyphKernelTest is GlyphKernelBase {
    // ── inscribe ──────────────────────────────────────────────────

    function test_inscribe_writesStateAndEmits() public {
        bytes memory content = "hello, glyph";
        uint256 expectedId = _glyphId(alice, content);

        vm.roll(1234);
        vm.expectEmit(true, true, true, true);
        emit GlyphTransfer(expectedId, address(0), alice);
        (uint256 id, bytes32 contentId) = _inscribe(alice, alice, content);

        assertEq(id, expectedId, "id");
        assertEq(id, kernel.glyphId(alice, content), "glyphId()");
        assertEq(contentId, keccak256(content), "contentId");
        assertEq(kernel.glyphCount(), 1, "count");
        assertEq(kernel.totalInscribedSize(), content.length, "total size");
        assertEq(kernel.burnCount(), 0, "burns");

        assertEq(kernel.creatorOf(id), _creatorId(alice, _contentId(content)));
        assertEq(kernel.contentIdOf(id), _contentId(content));
        assertTrue(kernel.verifyContent(id, content));
        assertFalse(kernel.verifyContent(id, "hello, glyph!"));

        assertTrue(kernel.exists(id));
        assertFalse(kernel.isBurned(id));
        assertFalse(kernel.isBurnt(id));
        assertTrue(kernel.isAlive(id));
        assertEq(kernel.glyphNumber(id), 1);
        assertEq(kernel.createdBlock(id), 1234);
        assertEq(kernel.ownerSinceBlock(id), 1234);
        assertEq(kernel.transferCount(id), 0);
        assertEq(kernel.ownerOf(id), _ownerId(alice, id));
    }

    function test_inscribe_provenanceOverloads() public {
        bytes memory content = "x";
        (uint256 id,) = _inscribe(alice, alice, content);
        uint256 contentId = _contentId(content);

        assertTrue(kernel.isOwner(id, alice));
        assertTrue(kernel.isOwner(id, _ownerId(alice, id)));
        assertTrue(kernel.isCreator(id, alice));
        assertTrue(kernel.isCreator(id, _creatorId(alice, contentId)));

        assertFalse(kernel.isOwner(id, bob));
        assertFalse(kernel.isOwner(id, _ownerId(bob, id)));
        assertFalse(kernel.isOwner(id, uint256(0)));
        assertFalse(kernel.isCreator(id, bob));
        assertFalse(kernel.isCreator(id, _creatorId(bob, contentId)));
        assertFalse(kernel.isCreator(id, uint256(0)));
        assertFalse(kernel.isOwner(id, address(0)));
        assertFalse(kernel.isCreator(id, address(0)));
    }

    function test_inscribe_identityIsSaltedPerGlyph() public {
        (uint256 a,) = _inscribe(alice, alice, "one");
        (uint256 b,) = _inscribe(alice, alice, "two");

        // same owner, same creator, different IDs: the stored IDs differ per glyph
        assertTrue(kernel.ownerOf(a) != kernel.ownerOf(b), "owner ids differ");
        assertTrue(kernel.creatorOf(a) != kernel.creatorOf(b), "creator ids differ");
        assertTrue(kernel.isOwner(a, alice) && kernel.isOwner(b, alice));
        assertTrue(kernel.isCreator(a, alice) && kernel.isCreator(b, alice));

        // an owner ID from one glyph means nothing for another
        assertFalse(kernel.isOwner(b, kernel.ownerOf(a)));
        assertFalse(kernel.isCreator(b, kernel.creatorOf(a)));
    }

    function test_inscribe_creatorIsSender() public {
        (uint256 id,) = _inscribe(bob, alice, "minted by bob, owned by alice");

        assertEq(id, _glyphId(bob, "minted by bob, owned by alice"));
        assertTrue(kernel.isOwner(id, alice));
        assertTrue(kernel.isCreator(id, bob));
        assertFalse(kernel.isOwner(id, bob));
        assertFalse(kernel.isCreator(id, alice));
    }

    function test_inscribe_sameContentDifferentCreators() public {
        (uint256 a,) = _inscribe(alice, alice, "gm");
        (uint256 b,) = _inscribe(bob, bob, "gm");

        assertTrue(a != b);
        assertEq(kernel.contentIdOf(a), kernel.contentIdOf(b));
        assertEq(kernel.glyphNumber(a), 1);
        assertEq(kernel.glyphNumber(b), 2);
    }

    function test_inscribe_alreadyInscribed() public {
        (uint256 id,) = _inscribe(alice, alice, "gm");

        // same creator + same bytes, every inscribe path and any owner
        bytes memory err = abi.encodeWithSelector(GlyphKernel.AlreadyInscribed.selector, id);
        vm.prank(alice);
        _expectRevertCall(abi.encodePacked(bytes1(0x01), bob, "gm"), err);
        vm.prank(alice);
        _expectRevertCall(_batchCalldata(alice, _contents("a", "gm", "b")), err);
        vm.prank(alice);
        vm.expectRevert(err);
        kernel.inscribe(alice, "gm");
        vm.prank(alice);
        vm.expectRevert(err);
        kernel.inscribe(carol, _contents("a", "gm", "b"));

        assertEq(kernel.glyphCount(), 1, "atomic");
    }

    function test_inscribe_sequentialNumbersAndStats() public {
        (uint256 a,) = _inscribe(alice, alice, "aa");
        (uint256 b,) = _inscribe(bob, bob, "bbb");
        (uint256 c,) = _inscribe(alice, alice, "");

        assertEq(kernel.glyphNumber(a), 1);
        assertEq(kernel.glyphNumber(b), 2);
        assertEq(kernel.glyphNumber(c), 3);
        assertEq(kernel.glyphCount(), 3);
        assertEq(kernel.totalInscribedSize(), 5);
    }

    function test_inscribe_maxContent() public {
        bytes memory content = new bytes(kernel.MAX_CONTENT_SIZE());
        (uint256 id,) = _inscribe(alice, alice, content);

        assertTrue(kernel.verifyContent(id, content));
        assertEq(kernel.totalInscribedSize(), kernel.MAX_CONTENT_SIZE());
    }

    function test_inscribe_reverts() public {
        _expectRevertCall("", abi.encodeWithSelector(GlyphKernel.InvalidCalldata.selector));
        _expectRevertCall(hex"01", abi.encodeWithSelector(GlyphKernel.InvalidCalldata.selector));
        _expectRevertCall(
            abi.encodePacked(bytes1(0x01), address(0), "x"),
            abi.encodeWithSelector(GlyphKernel.ZeroOwner.selector)
        );
        _expectRevertCall(
            abi.encodePacked(bytes1(0x01), alice, new bytes(kernel.MAX_CONTENT_SIZE() + 1)),
            abi.encodeWithSelector(
                GlyphKernel.ContentTooLarge.selector, kernel.MAX_CONTENT_SIZE() + 1
            )
        );
        _expectRevertCall(hex"05", abi.encodeWithSelector(GlyphKernel.UnknownOperation.selector, 5));
        _expectRevertCall(hex"00", abi.encodeWithSelector(GlyphKernel.UnknownOperation.selector, 0));
    }

    function test_inscribe_countOverflow() public {
        // `stats` is slot 0; put the 33-bit counter two below its maximum.
        vm.store(address(kernel), bytes32(0), bytes32(NUMBER_MAX - 2));

        _expectRevertCall(
            _batchCalldata(alice, _contents("a", "b", "c")),
            abi.encodeWithSelector(GlyphKernel.CountOverflow.selector)
        );
        bytes[] memory two = new bytes[](2);
        two[0] = "a";
        two[1] = "b";
        uint256[] memory ids = _inscribeBatch(alice, alice, two);
        assertEq(kernel.glyphNumber(ids[1]), NUMBER_MAX);
        assertEq(kernel.glyphCount(), NUMBER_MAX);

        _expectRevertCall(
            abi.encodePacked(bytes1(0x01), alice, "one too many"),
            abi.encodeWithSelector(GlyphKernel.CountOverflow.selector)
        );
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.CountOverflow.selector));
        kernel.inscribe(alice, "one too many");
    }

    function test_gettersOnUnknownGlyph() public {
        uint256 id = kernel.glyphId(alice, "never inscribed");

        assertFalse(kernel.exists(id));
        assertFalse(kernel.isBurned(id));
        assertFalse(kernel.isAlive(id));
        assertEq(kernel.glyphNumber(id), 0);
        assertEq(kernel.createdBlock(id), 0);
        assertEq(kernel.ownerSinceBlock(id), 0);
        assertEq(kernel.transferCount(id), 0);
        assertFalse(kernel.isOwner(id, alice));
        assertTrue(kernel.isCreator(id, alice), "creator is pure");
        assertTrue(kernel.verifyContent(id, "never inscribed"));

        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.NotInscribed.selector, id));
        kernel.ownerOf(id);
    }

    // ── ABI inscribe ──────────────────────────────────────────────

    function test_abiInscribe_matchesRaw() public {
        GlyphKernel twin = new GlyphKernel();
        bytes memory content = "same bytes, two paths";

        (uint256 rawId, bytes32 rawContentId) = _inscribe(bob, alice, content);

        vm.expectEmit(true, true, true, true, address(twin));
        emit GlyphTransfer(rawId, address(0), alice);
        vm.prank(bob);
        (uint256 abiId, bytes32 abiContentId) = twin.inscribe(alice, content);

        assertEq(abiId, rawId, "id");
        assertEq(abiContentId, rawContentId, "contentId");
        assertEq(twin.glyphs(abiId), kernel.glyphs(rawId), "ownership word");
        assertEq(twin.stats(), kernel.stats(), "stats");
    }

    function test_abiInscribe_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.ZeroOwner.selector));
        kernel.inscribe(address(0), "x");

        bytes memory tooLarge = new bytes(kernel.MAX_CONTENT_SIZE() + 1);
        vm.expectRevert(
            abi.encodeWithSelector(GlyphKernel.ContentTooLarge.selector, tooLarge.length)
        );
        kernel.inscribe(alice, tooLarge);
    }

    // ── batch inscribe ────────────────────────────────────────────

    function test_inscribeBatch_raw() public {
        bytes[] memory contents = _contents("one", "", "three!");

        vm.roll(77);
        for (uint256 i = 0; i < contents.length; ++i) {
            vm.expectEmit(true, true, true, true);
            emit GlyphTransfer(_glyphId(bob, contents[i]), address(0), alice);
        }
        uint256[] memory ids = _inscribeBatch(bob, alice, contents);

        assertEq(ids.length, 3);
        for (uint256 i = 0; i < ids.length; ++i) {
            assertEq(ids[i], _glyphId(bob, contents[i]));
            assertEq(kernel.glyphNumber(ids[i]), i + 1);
            assertTrue(kernel.isOwner(ids[i], alice));
            assertTrue(kernel.isCreator(ids[i], bob));
            assertEq(kernel.createdBlock(ids[i]), 77);
        }
        assertEq(kernel.glyphCount(), 3);
        assertEq(kernel.totalInscribedSize(), 9);

        // The packed return value is exactly the ID list ops 0x02 / 0x04 take.
        vm.prank(alice);
        (bool ok,) =
            address(kernel).call(abi.encodePacked(bytes1(0x02), bob, ids[0], ids[1], ids[2]));
        assertTrue(ok);
        assertTrue(kernel.isOwner(ids[2], bob));
    }

    function test_inscribeBatch_rawMaxContent() public {
        bytes[] memory contents = new bytes[](2);
        contents[0] = new bytes(kernel.MAX_CONTENT_SIZE());
        contents[1] = "tail";

        uint256[] memory ids = _inscribeBatch(alice, alice, contents);

        assertTrue(kernel.verifyContent(ids[0], contents[0]));
        assertTrue(kernel.verifyContent(ids[1], "tail"));
        assertEq(kernel.totalInscribedSize(), kernel.MAX_CONTENT_SIZE() + 4);
    }

    function test_inscribeBatch_rawReverts() public {
        bytes memory invalid = abi.encodeWithSelector(GlyphKernel.InvalidCalldata.selector);

        _expectRevertCall(abi.encodePacked(bytes1(0x03), alice), invalid);
        _expectRevertCall(abi.encodePacked(bytes1(0x03), alice, bytes1(0x00)), invalid);
        _expectRevertCall(abi.encodePacked(bytes1(0x03), alice, uint16(5), "ab"), invalid);
        _expectRevertCall(
            abi.encodePacked(bytes1(0x03), alice, uint16(1), "a", bytes1(0x00)), invalid
        );
        _expectRevertCall(
            abi.encodePacked(bytes1(0x03), address(0), uint16(1), "a"),
            abi.encodeWithSelector(GlyphKernel.ZeroOwner.selector)
        );

        bytes[] memory contents = _contents("ok", new bytes(kernel.MAX_CONTENT_SIZE() + 1), "ok");
        _expectRevertCall(
            _batchCalldata(alice, contents),
            abi.encodeWithSelector(
                GlyphKernel.ContentTooLarge.selector, kernel.MAX_CONTENT_SIZE() + 1
            )
        );

        // duplicate bytes inside one batch: the second one hits the first one's slot
        uint256 dup = _glyphId(address(this), "twice");
        _expectRevertCall(
            _batchCalldata(alice, _contents("twice", "x", "twice")),
            abi.encodeWithSelector(GlyphKernel.AlreadyInscribed.selector, dup)
        );
        assertEq(kernel.glyphCount(), 0, "batch is atomic");
    }

    function test_inscribeBatch_abiOneOwnerMatchesRaw() public {
        GlyphKernel twin = new GlyphKernel();
        bytes[] memory contents = _contents("one", "", "three!");

        uint256[] memory rawIds = _inscribeBatch(bob, alice, contents);

        for (uint256 i = 0; i < contents.length; ++i) {
            vm.expectEmit(true, true, true, true, address(twin));
            emit GlyphTransfer(rawIds[i], address(0), alice);
        }
        vm.prank(bob);
        uint256[] memory abiIds = twin.inscribe(alice, contents);

        assertEq(abiIds.length, rawIds.length);
        for (uint256 i = 0; i < rawIds.length; ++i) {
            assertEq(abiIds[i], rawIds[i]);
            assertEq(twin.glyphs(abiIds[i]), kernel.glyphs(rawIds[i]));
        }
        assertEq(twin.stats(), kernel.stats());
    }

    function test_inscribeBatch_abiManyOwners() public {
        address[] memory owners = new address[](3);
        owners[0] = alice;
        owners[1] = bob;
        owners[2] = carol;
        bytes[] memory contents = _contents("for alice", "for bob", "for carol");

        for (uint256 i = 0; i < 3; ++i) {
            vm.expectEmit(true, true, true, true);
            emit GlyphTransfer(_glyphId(dave, contents[i]), address(0), owners[i]);
        }
        vm.prank(dave);
        uint256[] memory ids = kernel.inscribe(owners, contents);

        for (uint256 i = 0; i < 3; ++i) {
            assertEq(kernel.glyphNumber(ids[i]), i + 1);
            assertTrue(kernel.isOwner(ids[i], owners[i]));
            assertTrue(kernel.isCreator(ids[i], dave), "airdropper is the creator");
        }
        assertEq(kernel.glyphCount(), 3);
        assertEq(kernel.totalInscribedSize(), 9 + 7 + 9);
    }

    function test_inscribeBatch_abiReverts() public {
        bytes[] memory none = new bytes[](0);
        address[] memory nobody = new address[](0);
        bytes[] memory three = _contents("a", "b", "c");
        address[] memory two = new address[](2);
        two[0] = alice;
        two[1] = bob;

        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidCalldata.selector));
        kernel.inscribe(alice, none);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidCalldata.selector));
        kernel.inscribe(nobody, none);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidCalldata.selector));
        kernel.inscribe(two, three);

        address[] memory withZero = new address[](3);
        withZero[0] = alice;
        withZero[2] = bob;
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.ZeroOwner.selector));
        kernel.inscribe(withZero, three);

        assertEq(kernel.glyphCount(), 0, "batch is atomic");
    }
}
