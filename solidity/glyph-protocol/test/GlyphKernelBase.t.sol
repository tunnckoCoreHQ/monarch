// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

// Shared fixture for the kernel test suites. The raw op-byte paths have no ABI;
// tests drive them with raw calldata.
// solhint-disable avoid-low-level-calls

import {Test} from "forge-std/Test.sol";
import {GlyphKernel} from "../src/GlyphKernel.sol";

abstract contract GlyphKernelBase is Test {
    event GlyphTransfer(uint256 indexed glyphId, address indexed from, address indexed to);

    error InscribeFailed();
    error TransferFailed();
    error BurnFailed();

    uint256 internal constant CONTENT_ID_BITS = 156;
    uint256 internal constant CONTENT_ID_MASK = (uint256(1) << CONTENT_ID_BITS) - 1;
    uint256 internal constant CREATOR_MASK = (uint256(1) << 100) - 1;
    uint256 internal constant OWNER_MASK = (uint256(1) << 130) - 1;

    // Ownership word shifts (see the contract header).
    uint256 internal constant NUMBER_SHIFT = 130;
    uint256 internal constant CREATED_BLOCK_SHIFT = 163;
    uint256 internal constant OWNER_SINCE_BLOCK_SHIFT = 194;
    uint256 internal constant TRANSFER_COUNT_SHIFT = 225;
    uint256 internal constant EXISTS_FLAG = uint256(1) << 254;
    uint256 internal constant BURNED_FLAG = uint256(1) << 255;
    uint256 internal constant TRANSFER_COUNT_MAX = (uint256(1) << 29) - 1;
    uint256 internal constant NUMBER_MAX = (uint256(1) << 33) - 1;

    // Stats shifts.
    uint256 internal constant TOTAL_SIZE_SHIFT = 33;
    uint256 internal constant BURN_COUNT_SHIFT = 97;

    bytes32 internal constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 internal constant INSCRIBE_TYPEHASH =
        keccak256("Inscribe(bytes32 contentId,address initialOwner,uint256 deadline)");
    bytes32 internal constant TRANSFER_TYPEHASH =
        keccak256("Transfer(uint256 glyphId,uint32 nonce,address to,uint256 deadline)");
    bytes32 internal constant AUTHORIZE_TYPEHASH =
        keccak256("Authorize(uint256 glyphId,uint32 nonce,address operator,uint256 deadline)");
    bytes32 internal constant BATCH_TRANSFER_TYPEHASH =
        keccak256("BatchTransfer(uint256[] glyphIds,uint32[] nonces,address to,uint256 deadline)");
    bytes32 internal constant BATCH_AUTHORIZE_TYPEHASH = keccak256(
        "BatchAuthorize(uint256[] glyphIds,uint32[] nonces,address operator,uint256 deadline)"
    );

    GlyphKernel internal kernel;
    address internal alice;
    uint256 internal aliceKey;
    address internal bob;
    uint256 internal bobKey;
    address internal carol;
    address internal dave = makeAddr("dave");

    function setUp() public {
        kernel = new GlyphKernel();
        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");
        carol = makeAddr("carol");
    }

    // ── identity helpers ──────────────────────────────────────────

    function _contentId(bytes memory content) internal pure returns (uint256) {
        return uint256(keccak256(content)) & CONTENT_ID_MASK;
    }

    function _creatorId(address a, uint256 contentId) internal pure returns (uint256) {
        return (uint256(keccak256(abi.encodePacked(a, contentId))) & CREATOR_MASK) | 1;
    }

    function _glyphId(address creator, bytes memory content) internal pure returns (uint256) {
        uint256 contentId = _contentId(content);

        return (_creatorId(creator, contentId) << CONTENT_ID_BITS) | contentId;
    }

    function _ownerId(address a, uint256 id) internal pure returns (uint256) {
        return (uint256(keccak256(abi.encodePacked(a, id))) & OWNER_MASK) | 1;
    }

    function _glyphSlot(uint256 id) internal pure returns (bytes32) {
        return keccak256(abi.encode(id, uint256(1)));
    }

    // ── raw op helpers ────────────────────────────────────────────

    function _inscribe(address sender, address owner, bytes memory content)
        internal
        returns (uint256 id, bytes32 contentId)
    {
        vm.prank(sender);
        (bool ok, bytes memory ret) =
            address(kernel).call(abi.encodePacked(bytes1(0x01), owner, content));
        if (!ok) {
            revert InscribeFailed();
        }
        (id, contentId) = abi.decode(ret, (uint256, bytes32));
    }

    function _batchCalldata(address owner, bytes[] memory contents)
        internal
        pure
        returns (bytes memory cd)
    {
        cd = abi.encodePacked(bytes1(0x03), owner);
        for (uint256 i = 0; i < contents.length; ++i) {
            cd = abi.encodePacked(cd, uint16(contents[i].length), contents[i]);
        }
    }

    function _inscribeBatch(address sender, address owner, bytes[] memory contents)
        internal
        returns (uint256[] memory ids)
    {
        vm.prank(sender);
        (bool ok, bytes memory ret) = address(kernel).call(_batchCalldata(owner, contents));
        if (!ok) {
            revert InscribeFailed();
        }
        assertEq(ret.length, contents.length * 32, "packed return length");
        ids = new uint256[](contents.length);
        for (uint256 i = 0; i < ids.length; ++i) {
            ids[i] = uint256(bytes32(_slice(ret, i * 32)));
        }
    }

    function _slice(bytes memory data, uint256 start) internal pure returns (bytes32 word) {
        assembly {
            word := mload(add(add(data, 0x20), start))
        }
    }

    function _transferCalldata(address to, uint256[] memory ids)
        internal
        pure
        returns (bytes memory cd)
    {
        cd = abi.encodePacked(bytes1(0x02), to);
        for (uint256 i = 0; i < ids.length; ++i) {
            cd = abi.encodePacked(cd, ids[i]);
        }
    }

    function _transfer(address from, address to, uint256[] memory ids) internal {
        vm.prank(from);
        (bool ok,) = address(kernel).call(_transferCalldata(to, ids));
        if (!ok) {
            revert TransferFailed();
        }
    }

    function _burnCalldata(uint256[] memory ids) internal pure returns (bytes memory cd) {
        cd = abi.encodePacked(bytes1(0x04));
        for (uint256 i = 0; i < ids.length; ++i) {
            cd = abi.encodePacked(cd, ids[i]);
        }
    }

    function _burn(address from, uint256[] memory ids) internal {
        vm.prank(from);
        (bool ok,) = address(kernel).call(_burnCalldata(ids));
        if (!ok) {
            revert BurnFailed();
        }
    }

    function _one(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function _contents(bytes memory a, bytes memory b, bytes memory c)
        internal
        pure
        returns (bytes[] memory list)
    {
        list = new bytes[](3);
        list[0] = a;
        list[1] = b;
        list[2] = c;
    }

    function _expectRevertCall(bytes memory cd, bytes memory err) internal {
        vm.expectRevert(err);
        (bool ok,) = address(kernel).call(cd);
        ok;
    }

    // ── signing helpers ───────────────────────────────────────────

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("Glyph Kernel"),
                keccak256("2"),
                block.chainid,
                address(kernel)
            )
        );

        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _sign(uint256 key, bytes32 structHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(structHash));

        return abi.encodePacked(r, s, v);
    }

    function _signInscribe(
        uint256 key,
        bytes memory content,
        address initialOwner,
        uint256 deadline
    ) internal view returns (bytes memory) {
        return _sign(
            key,
            keccak256(abi.encode(INSCRIBE_TYPEHASH, keccak256(content), initialOwner, deadline))
        );
    }

    function _transferStructHash(uint256 id, address to, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        uint32 nonce = kernel.transferCount(id);

        return keccak256(abi.encode(TRANSFER_TYPEHASH, id, nonce, to, deadline));
    }

    function _signTransfer(uint256 key, uint256 id, address to, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _sign(key, _transferStructHash(id, to, deadline));
    }

    function _signAuthorize(uint256 key, uint256 id, address operator, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        uint32 nonce = kernel.transferCount(id);

        return _sign(key, keccak256(abi.encode(AUTHORIZE_TYPEHASH, id, nonce, operator, deadline)));
    }

    function _noncesHash(uint256[] memory ids) internal view returns (bytes32) {
        uint32[] memory nonces = new uint32[](ids.length);
        for (uint256 i = 0; i < ids.length; ++i) {
            nonces[i] = kernel.transferCount(ids[i]);
        }

        return keccak256(abi.encodePacked(nonces));
    }

    function _signBatchTransfer(uint256 key, uint256[] memory ids, address to, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                BATCH_TRANSFER_TYPEHASH,
                keccak256(abi.encodePacked(ids)),
                _noncesHash(ids),
                to,
                deadline
            )
        );

        return _sign(key, structHash);
    }

    function _signBatchAuthorize(
        uint256 key,
        uint256[] memory ids,
        address operator,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                BATCH_AUTHORIZE_TYPEHASH,
                keccak256(abi.encodePacked(ids)),
                _noncesHash(ids),
                operator,
                deadline
            )
        );

        return _sign(key, structHash);
    }
}
