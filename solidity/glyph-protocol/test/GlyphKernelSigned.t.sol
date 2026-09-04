// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {GlyphKernel} from "../src/GlyphKernel.sol";
import {GlyphKernelBase} from "./GlyphKernelBase.t.sol";
import {Wallet1271} from "./Wallet1271.sol";

contract GlyphKernelSignedTest is GlyphKernelBase {
    uint256 internal constant SECP256K1_N =
        0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

    // ── domain ────────────────────────────────────────────────────

    function test_eip712Domain() public view {
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
        ) = kernel.eip712Domain();

        assertEq(fields, bytes1(0x0f));
        assertEq(name, "Glyph Kernel");
        assertEq(version, "2");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(kernel));
        assertEq(salt, bytes32(0));
    }

    // ── signed transfer ───────────────────────────────────────────

    function test_transferWithSig() public {
        (uint256 id,) = _inscribe(alice, alice, "signed away");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signTransfer(aliceKey, id, bob, deadline);

        vm.warp(deadline);
        vm.expectEmit(true, true, true, true);
        emit GlyphTransfer(id, alice, bob);
        vm.prank(carol);
        kernel.transferWithSig(alice, bob, id, deadline, sig);

        assertTrue(kernel.isOwner(id, bob));
        assertFalse(kernel.isOwner(id, alice));
        assertEq(kernel.transferCount(id), 1);
    }

    function test_transferWithSig_reverts() public {
        (uint256 id,) = _inscribe(alice, alice, "signed away");
        (uint256 bobs,) = _inscribe(bob, bob, "bob's");
        uint256 ghost = kernel.glyphId(alice, "ghost");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signTransfer(aliceKey, id, bob, deadline);

        // expired
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.SignatureExpired.selector));
        kernel.transferWithSig(alice, bob, id, deadline, sig);
        vm.warp(deadline);

        // recipient differs from the signed one
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.transferWithSig(alice, carol, id, deadline, sig);

        // zero recipient, even when signed
        bytes memory toZero = _signTransfer(aliceKey, id, address(0), deadline);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.ZeroRecipient.selector));
        kernel.transferWithSig(alice, address(0), id, deadline, toZero);

        // `from` is not the owner
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.Unauthorized.selector));
        kernel.transferWithSig(bob, carol, id, deadline, sig);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.NotInscribed.selector, ghost));
        kernel.transferWithSig(alice, bob, ghost, deadline, sig);

        // signed by someone other than `from`
        bytes memory wrongSigner = _signTransfer(aliceKey, bobs, carol, deadline);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.transferWithSig(bob, carol, bobs, deadline, wrongSigner);

        // garbage signature
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.transferWithSig(alice, bob, id, deadline, hex"deadbeef");

        // happy path, then replay: the transfer bumped the nonce
        kernel.transferWithSig(alice, bob, id, deadline, sig);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.Unauthorized.selector));
        kernel.transferWithSig(alice, bob, id, deadline, sig);

        // bob hands it back; alice's old signature is still dead (nonce is 2 now)
        _transfer(bob, alice, _one(id));
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.transferWithSig(alice, bob, id, deadline, sig);
    }

    function test_transferWithSig_cancelBySelfTransfer() public {
        (uint256 id,) = _inscribe(alice, alice, "listed");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signTransfer(aliceKey, id, bob, deadline);

        _transfer(alice, alice, _one(id));

        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.transferWithSig(alice, bob, id, deadline, sig);
        assertTrue(kernel.isOwner(id, alice));
    }

    function test_transferWithSig_erc1271() public {
        Wallet1271 wallet = new Wallet1271(alice);
        (uint256 id,) = _inscribe(alice, address(wallet), "held by a smart wallet");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory notTheWalletOwner = _signTransfer(bobKey, id, bob, deadline);
        bytes memory walletOwner = _signTransfer(aliceKey, id, bob, deadline);

        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.transferWithSig(address(wallet), bob, id, deadline, notTheWalletOwner);

        vm.expectEmit(true, true, true, true);
        emit GlyphTransfer(id, address(wallet), bob);
        kernel.transferWithSig(address(wallet), bob, id, deadline, walletOwner);
        assertTrue(kernel.isOwner(id, bob));
    }

    function test_transferWithAuth() public {
        (uint256 id,) = _inscribe(alice, alice, "for sale");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signAuthorize(aliceKey, id, carol, deadline);

        // only the signed operator may use it
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.transferWithAuth(alice, bob, id, deadline, sig);

        // the operator cannot send to zero
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.ZeroRecipient.selector));
        kernel.transferWithAuth(alice, address(0), id, deadline, sig);

        // the operator picks the recipient
        vm.expectEmit(true, true, true, true);
        emit GlyphTransfer(id, alice, dave);
        vm.prank(carol);
        kernel.transferWithAuth(alice, dave, id, deadline, sig);
        assertTrue(kernel.isOwner(id, dave));

        // spent
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.Unauthorized.selector));
        kernel.transferWithAuth(alice, dave, id, deadline, sig);
    }

    function test_transferWithAuth_erc1271() public {
        Wallet1271 wallet = new Wallet1271(alice);
        (uint256 id,) = _inscribe(alice, address(wallet), "held by a smart wallet");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signAuthorize(aliceKey, id, carol, deadline);

        vm.prank(carol);
        kernel.transferWithAuth(address(wallet), dave, id, deadline, sig);

        assertTrue(kernel.isOwner(id, dave));
        assertFalse(kernel.isOwner(id, address(wallet)));
    }

    function test_transferWithSig_batch() public {
        uint256[] memory ids = _inscribeBatch(alice, alice, _contents("a", "b", "c"));
        _transfer(alice, alice, _one(ids[1])); // distinct nonces inside the batch
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signBatchTransfer(aliceKey, ids, bob, deadline);

        for (uint256 i = 0; i < ids.length; ++i) {
            vm.expectEmit(true, true, true, true);
            emit GlyphTransfer(ids[i], alice, bob);
        }
        vm.prank(carol);
        kernel.transferWithSig(alice, bob, ids, deadline, sig);

        for (uint256 i = 0; i < ids.length; ++i) {
            assertTrue(kernel.isOwner(ids[i], bob));
        }
        assertEq(kernel.transferCount(ids[1]), 2);

        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.Unauthorized.selector));
        kernel.transferWithSig(alice, bob, ids, deadline, sig);
    }

    function test_transferWithSig_batchReverts() public {
        uint256[] memory ids = _inscribeBatch(alice, alice, _contents("a", "b", "c"));
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signBatchTransfer(aliceKey, ids, bob, deadline);

        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidCalldata.selector));
        kernel.transferWithSig(alice, bob, new uint256[](0), deadline, sig);

        bytes memory toZero = _signBatchTransfer(aliceKey, ids, address(0), deadline);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.ZeroRecipient.selector));
        kernel.transferWithSig(alice, address(0), ids, deadline, toZero);

        // a stale nonce on one glyph invalidates the whole signature
        _transfer(alice, alice, _one(ids[2]));
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.transferWithSig(alice, bob, ids, deadline, sig);

        // one glyph not owned by `from`: atomic revert
        sig = _signBatchTransfer(aliceKey, ids, bob, deadline);
        _transfer(alice, carol, _one(ids[0]));
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.Unauthorized.selector));
        kernel.transferWithSig(alice, bob, ids, deadline, sig);
        assertTrue(kernel.isOwner(ids[1], alice));
        assertTrue(kernel.isOwner(ids[2], alice));
    }

    function test_transferWithAuth_batch() public {
        uint256[] memory ids = _inscribeBatch(alice, alice, _contents("a", "b", "c"));
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signBatchAuthorize(aliceKey, ids, carol, deadline);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.transferWithAuth(alice, bob, ids, deadline, sig);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.ZeroRecipient.selector));
        kernel.transferWithAuth(alice, address(0), ids, deadline, sig);

        for (uint256 i = 0; i < ids.length; ++i) {
            vm.expectEmit(true, true, true, true);
            emit GlyphTransfer(ids[i], alice, dave);
        }
        vm.prank(carol);
        kernel.transferWithAuth(alice, dave, ids, deadline, sig);

        for (uint256 i = 0; i < ids.length; ++i) {
            assertTrue(kernel.isOwner(ids[i], dave));
            assertEq(kernel.transferCount(ids[i]), 1);
        }
    }

    // ── signed inscribe ───────────────────────────────────────────

    function test_inscribeWithSig() public {
        bytes memory content = "signed mint";
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signInscribe(aliceKey, content, bob, deadline);
        uint256 expectedId = _glyphId(alice, content);

        vm.warp(deadline);
        vm.expectEmit(true, true, true, true);
        emit GlyphTransfer(expectedId, address(0), bob);
        vm.prank(carol);
        (uint256 id, bytes32 contentId) = kernel.inscribeWithSig(alice, bob, content, deadline, sig);

        assertEq(id, expectedId, "signer is the creator");
        assertEq(contentId, keccak256(content));
        assertTrue(kernel.isCreator(id, alice));
        assertTrue(kernel.isOwner(id, bob));
        assertFalse(kernel.isOwner(id, carol));
        assertEq(kernel.glyphCount(), 1);
        assertEq(kernel.totalInscribedSize(), content.length);

        // replay: the ID is the nonce
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.AlreadyInscribed.selector, id));
        kernel.inscribeWithSig(alice, bob, content, deadline, sig);

        // the same bytes from alice herself collide too
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.AlreadyInscribed.selector, id));
        kernel.inscribe(alice, content);
    }

    function test_inscribeWithSig_reverts() public {
        bytes memory content = "signed mint";
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signInscribe(aliceKey, content, bob, deadline);

        // expired
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.SignatureExpired.selector));
        kernel.inscribeWithSig(alice, bob, content, deadline, sig);
        vm.warp(deadline);

        // wrong signer for the claimed creator
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.inscribeWithSig(bob, bob, content, deadline, sig);

        // owner / content / deadline differ from what was signed
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.inscribeWithSig(alice, carol, content, deadline, sig);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.inscribeWithSig(alice, bob, "other bytes", deadline, sig);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.inscribeWithSig(alice, bob, content, deadline + 1, sig);

        // zero creator can never verify: neither a real signature nor a failed recovery
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.inscribeWithSig(address(0), bob, content, deadline, sig);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.inscribeWithSig(address(0), bob, content, deadline, new bytes(65));
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.inscribeWithSig(address(0), bob, content, deadline, new bytes(64));

        // signed, but to the zero address
        bytes memory toZero = _signInscribe(aliceKey, content, address(0), deadline);
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.ZeroOwner.selector));
        kernel.inscribeWithSig(alice, address(0), content, deadline, toZero);

        assertEq(kernel.glyphCount(), 0);
    }

    function test_inscribeWithSig_erc1271() public {
        Wallet1271 wallet = new Wallet1271(alice);
        bytes memory content = "minted by a smart wallet";
        uint256 deadline = block.timestamp + 1 days;
        bytes memory notTheWalletOwner = _signInscribe(bobKey, content, bob, deadline);
        bytes memory walletOwner = _signInscribe(aliceKey, content, bob, deadline);

        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.inscribeWithSig(address(wallet), bob, content, deadline, notTheWalletOwner);

        (uint256 id,) = kernel.inscribeWithSig(address(wallet), bob, content, deadline, walletOwner);

        assertEq(id, _glyphId(address(wallet), content));
        assertTrue(kernel.isCreator(id, address(wallet)));
        assertTrue(kernel.isOwner(id, bob));
    }

    // ── canonical ECDSA ───────────────────────────────────────────

    function _split(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
    }

    function _malleable(bytes memory sig) internal pure returns (bytes memory) {
        (bytes32 r, bytes32 s, uint8 v) = _split(sig);
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;

        return abi.encodePacked(r, highS, flippedV);
    }

    function _compact(bytes memory sig) internal pure returns (bytes memory) {
        (bytes32 r, bytes32 s, uint8 v) = _split(sig);
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));

        return abi.encodePacked(r, vs);
    }

    function test_ecdsa_highSRejectedForEoa() public {
        (uint256 id,) = _inscribe(alice, alice, "gm");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory highS = _malleable(_signTransfer(aliceKey, id, bob, deadline));

        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.transferWithSig(alice, bob, id, deadline, highS);

        bytes memory mint = _malleable(_signInscribe(aliceKey, "signed mint", bob, deadline));
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.inscribeWithSig(alice, bob, "signed mint", deadline, mint);
    }

    function test_ecdsa_highSAcceptedByWillingWallet() public {
        Wallet1271 wallet = new Wallet1271(alice);
        (uint256 id,) = _inscribe(alice, address(wallet), "held by a smart wallet");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory highS = _malleable(_signTransfer(aliceKey, id, bob, deadline));

        kernel.transferWithSig(address(wallet), bob, id, deadline, highS);

        assertTrue(kernel.isOwner(id, bob));
    }

    function test_ecdsa_badV() public {
        (uint256 id,) = _inscribe(alice, alice, "gm");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signTransfer(aliceKey, id, bob, deadline);
        sig[64] = bytes1(uint8(sig[64]) + 2); // 29 or 30

        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.transferWithSig(alice, bob, id, deadline, sig);
    }

    function test_ecdsa_compactAccepted() public {
        (uint256 id,) = _inscribe(alice, alice, "gm");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory compact = _compact(_signTransfer(aliceKey, id, bob, deadline));
        assertEq(compact.length, 64);

        kernel.transferWithSig(alice, bob, id, deadline, compact);

        assertTrue(kernel.isOwner(id, bob));
    }

    function test_ecdsa_lengthsRejected() public {
        (uint256 id,) = _inscribe(alice, alice, "gm");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signTransfer(aliceKey, id, bob, deadline);

        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.transferWithSig(alice, bob, id, deadline, abi.encodePacked(sig, bytes1(0)));
        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.transferWithSig(alice, bob, id, deadline, "");
    }

    function testFuzz_transferWithSig_onlyOwnerKey(uint256 key) public {
        key = bound(key, 1, SECP256K1_N - 1);
        vm.assume(key != aliceKey);
        (uint256 id,) = _inscribe(alice, alice, "gm");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signTransfer(key, id, bob, deadline);

        vm.expectRevert(abi.encodeWithSelector(GlyphKernel.InvalidSignature.selector));
        kernel.transferWithSig(alice, bob, id, deadline, sig);
    }
}
