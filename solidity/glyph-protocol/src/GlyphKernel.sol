// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {EIP712} from "solady/utils/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title Glyph Kernel
/// @author tunnckoCore
/// @notice Minimal on-chain inscription protocol. Content lives on-chain
///         in transaction calldata; the kernel keeps a compact, fully
///         queryable ownership record in EVM state — one storage slot per
///         glyph plus one global `stats` slot.
///
/// @dev    ## Basics
///
///         Every write exists twice: as a raw op-byte payload handled by
///         `fallback` (cheapest, no ABI) and as an ABI method (tooling,
///         explorers, multicall). Both share the same internals and produce
///         identical state and events.
///
///         * **Inscribe** — raw `0x01 ‖ initialOwner(20) ‖ content` or ABI
///           `inscribe(initialOwner, content)`. `msg.sender` is the creator.
///           The kernel derives the content-addressed glyph ID, assigns a
///           sequential number, writes one slot, emits `GlyphTransfer` from
///           `0x0`, and returns `(glyphId, contentId)`.
///         * **Batch inscribe** — raw `0x03 ‖ initialOwner(20) ‖ (size(2) ‖ content)+`
///           or ABI `inscribe(initialOwner, contents[])` /
///           `inscribe(initialOwners[], contents[])`. `stats` written once.
///         * **Signed inscribe** — `inscribeWithSig`: the creator signs
///           `Inscribe` typed data, anyone relays. The signer is the creator.
///         * **Transfer** — raw `0x02 ‖ recipient(20) ‖ glyphId(32)…` or ABI
///           `transfer(to, id)` / `transfer(to, ids[])` moves one or many
///           glyphs from `msg.sender` to a single recipient.
///         * **Signed transfer** — `transferWithSig` (owner signs the
///           recipient) and `transferWithAuth` (owner signs an operator, the
///           operator picks the recipient), single or batch. The per-glyph
///           nonce is `transferCount(id)`, so every transfer invalidates all
///           outstanding signatures for that glyph and a self-transfer is a
///           cancel.
///         * **Burn** — raw `0x04 ‖ glyphId(32)…` or ABI `burn(id)` /
///           `burn(ids[])`. Owner only. The glyph keeps its slot, number and
///           created block; the owner becomes `0x0` and nothing can move it
///           again.
///         * **No receiver hook** — like ERC-20, the kernel does not call the
///           recipient. A contract that cannot call `transfer` keeps the glyph
///           forever; make sure the recipient can act.
///         * **Content** is on-chain in the inscribing tx's calldata —
///           permanent and indexable, just not readable by other contracts.
///           EVM state holds only the truncated `keccak256(content)` inside
///           the ID. Max 24,200 bytes.
///
///         ## Identity model
///
///         Addresses are not kept in EVM state. Every identity field is a
///         truncated, salted `keccak256` with the low bit forced to `1`, so
///         `0` always means "none":
///
///         * **creator ID** — `uint100(keccak256(addr ‖ contentId)) | 1`, salted
///           with the content; lives in the glyph ID.
///         * **current owner ID** — `uint130(keccak256(addr ‖ glyphId)) | 1`,
///           salted with the glyph ID; lives in the ownership word.
///
///         The salt stops any-of-N grinding: a found preimage opens exactly one
///         glyph. The raw address is *verifiable* on-chain (`isOwner`,
///         `isCreator`) and *resolvable* off-chain from `GlyphTransfer`, which
///         carries full addresses. Signed transfers pass `from` explicitly for
///         the same reason.
///
///         ## Layouts
///
///         Glyph ID (`uint256`, identical on every chain):
///         ```
///         bits   0..155  content ID     (156)  low 156 bits of keccak256(content)
///         bits 156..255  creator ID     (100)  uint100(keccak256(creator ‖ contentId)) | 1
///         ```
///         Same creator + same bytes = same ID = same slot, so a creator can
///         inscribe given bytes once (`AlreadyInscribed`).
///
///         Ownership word (`glyphs[id]`, `uint256`; widths are the `*_BITS`
///         constants below — other deployments may retune the slot, never the ID):
///         ```
///         bits   0..129  current owner ID      (130)  0 once burned
///         bits 130..162  glyph number          (33)   sequential, 1-based
///         bits 163..193  created block         (31)   block.number − DEPLOY_BLOCK
///         bits 194..224  owner-since block     (31)   block.number − DEPLOY_BLOCK
///         bits 225..253  transfer count        (29)   also the EIP-712 nonce
///         bits 254..255  flags                 (2)    bit 0 = EXISTS, bit 1 = BURNED
///         ```
///
///         Stats (`stats`, `uint256`):
///         ```
///         bits   0..32   glyph count           (33)
///         bits  33..96   total inscribed bytes (64)
///         bits  97..129  burn count            (33)
///         bits 130..255  free
///         ```
///
///         ## EIP-712
///
///         Domain: `name = "Glyph Kernel"`, `version = "2"`, `chainId`,
///         `verifyingContract` (ERC-5267 `eip712Domain()` exposes it).
///         ```
///         Inscribe(bytes32 contentId,address initialOwner,uint256 deadline)
///         Transfer(uint256 glyphId,uint32 nonce,address to,uint256 deadline)
///         Authorize(uint256 glyphId,uint32 nonce,address operator,uint256 deadline)
///         BatchTransfer(uint256[] glyphIds,uint32[] nonces,address to,uint256 deadline)
///         BatchAuthorize(uint256[] glyphIds,uint32[] nonces,address operator,uint256 deadline)
///         ```
///         `contentId` in `Inscribe` is the full `keccak256(content)`; `nonce`
///         is `transferCount(glyphId)` at signing time. Signers without code
///         use ECDSA (OpenZeppelin `ECDSA`: non-malleable, 65-byte or 64-byte
///         EIP-2098); signers with code use ERC-1271 and decide for themselves.
contract GlyphKernel is EIP712 {
    /// @notice This creator already inscribed these exact bytes.
    /// @param glyphId The existing glyph ID.
    error AlreadyInscribed(uint256 glyphId);

    /// @notice The glyph was burned; nothing can move it.
    /// @param glyphId The burned glyph ID.
    error Burned(uint256 glyphId);

    /// @notice Content exceeds `MAX_CONTENT_SIZE`.
    /// @param size The rejected content length in bytes.
    error ContentTooLarge(uint256 size);

    /// @notice The 33-bit glyph counter is exhausted.
    error CountOverflow();

    /// @notice Calldata is empty, too short, mis-aligned, or the batch is
    ///         empty / has mismatched array lengths.
    error InvalidCalldata();

    /// @notice The signature does not verify for the signer over the expected
    ///         typed data (wrong signer, stale nonce, wrong operator,
    ///         non-canonical ECDSA, or a rejecting ERC-1271 wallet).
    error InvalidSignature();

    /// @notice The glyph ID was never inscribed.
    /// @param glyphId The unknown glyph ID.
    error NotInscribed(uint256 glyphId);

    /// @notice `block.timestamp` is past the signed `deadline`.
    error SignatureExpired();

    /// @notice The 29-bit transfer counter for this glyph is exhausted.
    /// @param glyphId The affected glyph ID.
    error TransferCountOverflow(uint256 glyphId);

    /// @notice Caller (or the signed `from`) is not the current owner of the glyph.
    error Unauthorized();

    /// @notice First calldata byte is not a known operation code.
    /// @param operation The rejected op byte.
    error UnknownOperation(uint8 operation);

    /// @notice Inscribe was called with `address(0)` as the initial owner.
    error ZeroOwner();

    /// @notice A transfer named `address(0)` as the recipient. Burn instead.
    error ZeroRecipient();

    /// @notice The one event. Mint: `from = 0x0`. Burn: `to = 0x0`.
    /// @param glyphId Glyph ID.
    /// @param from    Previous owner (full address); the signer for signed
    ///                transfers, never the relayer.
    /// @param to      New owner (full address).
    event GlyphTransfer(uint256 indexed glyphId, address indexed from, address indexed to);

    // ──────────────────────────────────────────────────────────────
    //  Glyph ID layout — fixed on every chain
    // ──────────────────────────────────────────────────────────────

    /// @dev Width of the content ID (ID bits 0..155). The creator ID takes the rest.
    uint256 private constant CONTENT_ID_BITS = 156;

    /// @dev Mask for the content ID.
    uint256 private constant CONTENT_ID_MASK = (uint256(1) << CONTENT_ID_BITS) - 1;

    /// @dev Mask for the 100-bit creator ID, before it is shifted into place.
    uint256 private constant CREATOR_MASK = (uint256(1) << (256 - CONTENT_ID_BITS)) - 1;

    // ──────────────────────────────────────────────────────────────
    //  Ownership word layout — widths first, everything else derived
    // ──────────────────────────────────────────────────────────────

    /// @dev Width of the current owner ID.
    uint256 private constant CURRENT_OWNER_BITS = 130;

    /// @dev Width of the glyph number; also the width of both `stats` counters.
    uint256 private constant NUMBER_BITS = 33;

    /// @dev Width of each block field (created, owner-since).
    uint256 private constant BLOCK_BITS = 31;

    /// @dev Width of the transfer count.
    uint256 private constant TRANSFER_COUNT_BITS = 29;

    /// @dev Shift of the glyph number.
    uint256 private constant NUMBER_SHIFT = CURRENT_OWNER_BITS;

    /// @dev Shift of the created block.
    uint256 private constant CREATED_BLOCK_SHIFT = NUMBER_SHIFT + NUMBER_BITS;

    /// @dev Shift of the owner-since block.
    uint256 private constant OWNER_SINCE_BLOCK_SHIFT = CREATED_BLOCK_SHIFT + BLOCK_BITS;

    /// @dev Shift of the transfer count.
    uint256 private constant TRANSFER_COUNT_SHIFT = OWNER_SINCE_BLOCK_SHIFT + BLOCK_BITS;

    /// @dev Shift of the two flag bits; `FLAGS_SHIFT + 2 == 256`.
    uint256 private constant FLAGS_SHIFT = TRANSFER_COUNT_SHIFT + TRANSFER_COUNT_BITS;

    /// @dev Mask for the current owner ID (ownership bits 0..129).
    uint256 private constant CURRENT_OWNER_MASK = (uint256(1) << CURRENT_OWNER_BITS) - 1;

    /// @dev Max glyph number, glyph count and burn count.
    uint256 private constant NUMBER_MAX = (uint256(1) << NUMBER_BITS) - 1;

    /// @dev Mask for a block field (relative to `DEPLOY_BLOCK`, wraps).
    uint256 private constant BLOCK_MASK = (uint256(1) << BLOCK_BITS) - 1;

    /// @dev Max transfer count.
    uint256 private constant TRANSFER_COUNT_MAX = (uint256(1) << TRANSFER_COUNT_BITS) - 1;

    /// @dev Flag bit 0, in place: the glyph has been inscribed. Never cleared.
    uint256 private constant EXISTS_FLAG = uint256(1) << FLAGS_SHIFT;

    /// @dev Flag bit 1, in place: the glyph has been burned.
    uint256 private constant BURNED_FLAG = uint256(2) << FLAGS_SHIFT;

    /// @dev In-place bits a move keeps: number, created block, flags.
    uint256 private constant KEPT_ON_MOVE = (NUMBER_MAX << NUMBER_SHIFT)
        | (BLOCK_MASK << CREATED_BLOCK_SHIFT) | EXISTS_FLAG | BURNED_FLAG;

    // ──────────────────────────────────────────────────────────────
    //  Stats layout
    // ──────────────────────────────────────────────────────────────

    /// @dev Shift of the total inscribed size (glyph count sits below it).
    uint256 private constant TOTAL_SIZE_SHIFT = NUMBER_BITS;

    /// @dev Mask for the 64-bit total inscribed size.
    uint256 private constant TOTAL_SIZE_MASK = type(uint64).max;

    /// @dev Shift of the burn count.
    uint256 private constant BURN_COUNT_SHIFT = TOTAL_SIZE_SHIFT + 64;

    // ──────────────────────────────────────────────────────────────
    //  Protocol constants
    // ──────────────────────────────────────────────────────────────

    /// @notice Maximum content length accepted by inscribe, in bytes.
    uint256 public constant MAX_CONTENT_SIZE = 24_200;

    /// @notice Block the kernel was deployed in. Both block fields of the
    ///         ownership word are stored relative to it.
    uint256 public immutable DEPLOY_BLOCK;

    /// @dev EIP-712 type hash for `inscribeWithSig`.
    bytes32 private constant INSCRIBE_TYPEHASH =
        keccak256("Inscribe(bytes32 contentId,address initialOwner,uint256 deadline)");

    /// @dev EIP-712 type hash for `transferWithSig(from, to, id, deadline, sig)`.
    bytes32 private constant TRANSFER_TYPEHASH =
        keccak256("Transfer(uint256 glyphId,uint32 nonce,address to,uint256 deadline)");

    /// @dev EIP-712 type hash for `transferWithAuth(from, to, id, deadline, sig)`.
    bytes32 private constant AUTHORIZE_TYPEHASH =
        keccak256("Authorize(uint256 glyphId,uint32 nonce,address operator,uint256 deadline)");

    /// @dev EIP-712 type hash for `transferWithSig(from, to, ids, deadline, sig)`.
    bytes32 private constant BATCH_TRANSFER_TYPEHASH =
        keccak256("BatchTransfer(uint256[] glyphIds,uint32[] nonces,address to,uint256 deadline)");

    /// @dev EIP-712 type hash for `transferWithAuth(from, to, ids, deadline, sig)`.
    bytes32 private constant BATCH_AUTHORIZE_TYPEHASH = keccak256(
        "BatchAuthorize(uint256[] glyphIds,uint32[] nonces,address operator,uint256 deadline)"
    );

    /// @notice Packed global counters.
    /// @dev bits 0..32 glyph count · bits 33..96 total inscribed size ·
    ///      bits 97..129 burn count · rest free. See `glyphCount`,
    ///      `totalInscribedSize`, `burnCount`.
    uint256 public stats;

    /// @notice Packed ownership word per glyph ID (see contract-level layout).
    /// @dev `0` means the glyph was never inscribed. Prefer the typed
    ///      getters (`ownerOf`, `glyphNumber`, `createdBlock`, …) over
    ///      decoding this manually.
    mapping(uint256 glyphId => uint256 ownership) public glyphs;

    constructor() {
        DEPLOY_BLOCK = block.number;
    }

    /// @notice Raw-calldata dispatcher — the cheapest write path.
    /// @dev First byte selects the operation:
    ///      * `0x01` inscribe       — `0x01 ‖ initialOwner(20) ‖ content(0..24200)`
    ///                                returns `abi.encode(uint256 glyphId, bytes32 contentId)`
    ///      * `0x02` transfer       — `0x02 ‖ recipient(20) ‖ (glyphId(32))+`
    ///      * `0x03` batch inscribe — `0x03 ‖ initialOwner(20) ‖ (size(2) ‖ content)+`
    ///                                returns the new glyph IDs packed as 32 bytes each
    ///      * `0x04` burn           — `0x04 ‖ (glyphId(32))+`
    ///      Anything else reverts `UnknownOperation`; empty calldata reverts
    ///      `InvalidCalldata`. The contract has no `receive`, so plain ETH
    ///      sends revert. No ABI selector of this contract starts with a byte
    ///      in `0x01..0x04`, so raw payloads always reach the fallback.
    // The op-byte dispatcher is the raw write ABI by design.
    // solhint-disable-next-line no-complex-fallback
    fallback() external {
        if (msg.data.length == 0) {
            revert InvalidCalldata();
        }

        uint8 operation = uint8(msg.data[0]);

        if (operation == 0x01) {
            _inscribe(); // exits via assembly `return`
        }

        if (operation == 0x02) {
            _transfer();
            return;
        }

        if (operation == 0x03) {
            _inscribeBatch(); // exits via assembly `return`
        }

        if (operation == 0x04) {
            _burn();
            return;
        }

        revert UnknownOperation(operation);
    }

    // ──────────────────────────────────────────────────────────────
    //  ABI write methods (same internals as the raw ops)
    // ──────────────────────────────────────────────────────────────

    /// @notice Inscribe one glyph; `msg.sender` is the creator. ABI twin of raw op `0x01`.
    /// @param initialOwner First owner. Must not be `address(0)`.
    /// @param content      Content bytes, at most `MAX_CONTENT_SIZE`.
    /// @return id        The new glyph ID.
    /// @return contentId `keccak256(content)`.
    function inscribe(address initialOwner, bytes calldata content)
        external
        returns (uint256 id, bytes32 contentId)
    {
        uint256 number = _reserveGlyphs(1, content.length);
        contentId = keccak256(content);
        id = _inscribeOne(msg.sender, initialOwner, contentId, content.length, number);
    }

    /// @notice Inscribe many glyphs to one owner. ABI twin of raw op `0x03`.
    /// @param initialOwner First owner of every glyph.
    /// @param contents     Content of each glyph, in order.
    /// @return ids The new glyph IDs, in order.
    function inscribe(address initialOwner, bytes[] calldata contents)
        external
        returns (uint256[] memory ids)
    {
        uint256 count = contents.length;
        if (count == 0) {
            revert InvalidCalldata();
        }

        uint256 number = _reserveGlyphs(count, _totalLength(contents));
        ids = new uint256[](count);

        for (uint256 i = 0; i < count; ++i) {
            bytes calldata content = contents[i];
            ids[i] = _inscribeOne(
                msg.sender, initialOwner, keccak256(content), content.length, number + i
            );
        }
    }

    /// @notice Inscribe many glyphs, each to its own owner (airdrop / mint-to-many).
    /// @param initialOwners First owner per glyph. Same length as `contents`.
    /// @param contents      Content per glyph.
    /// @return ids The new glyph IDs, in order.
    function inscribe(address[] calldata initialOwners, bytes[] calldata contents)
        external
        returns (uint256[] memory ids)
    {
        uint256 count = contents.length;
        if (count == 0 || initialOwners.length != count) {
            revert InvalidCalldata();
        }

        uint256 number = _reserveGlyphs(count, _totalLength(contents));
        ids = new uint256[](count);

        for (uint256 i = 0; i < count; ++i) {
            bytes calldata content = contents[i];
            ids[i] = _inscribeOne(
                msg.sender, initialOwners[i], keccak256(content), content.length, number + i
            );
        }
    }

    /// @notice Inscribe one glyph on behalf of `creator`, who signed it; anyone may relay.
    /// @dev    Typed data `Inscribe(bytes32 contentId,address initialOwner,uint256 deadline)`
    ///         with `contentId = keccak256(content)`. No nonce: the glyph ID is
    ///         content-keyed per creator, so a second submission reverts
    ///         `AlreadyInscribed`. Reverts: `SignatureExpired`, `InvalidSignature`,
    ///         plus anything from `inscribe`.
    /// @param creator      Signer and creator (EOA or ERC-1271).
    /// @param initialOwner First owner. Must not be `address(0)`.
    /// @param content      Content bytes, at most `MAX_CONTENT_SIZE`.
    /// @param deadline     Last valid `block.timestamp`, inclusive.
    /// @param signature    ECDSA (65 or 64 bytes) or ERC-1271 signature by `creator`.
    /// @return id        The new glyph ID.
    /// @return contentId `keccak256(content)`.
    function inscribeWithSig(
        address creator,
        address initialOwner,
        bytes calldata content,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 id, bytes32 contentId) {
        contentId = keccak256(content);
        bytes32 structHash =
            keccak256(abi.encode(INSCRIBE_TYPEHASH, contentId, initialOwner, deadline));
        _verifySignature(creator, structHash, deadline, signature);

        uint256 number = _reserveGlyphs(1, content.length);
        id = _inscribeOne(creator, initialOwner, contentId, content.length, number);
    }

    /// @notice Move one glyph owned by `msg.sender` to `to`.
    /// @dev    A self-transfer (`to == msg.sender`) bumps `transferCount` and
    ///         thereby cancels every outstanding signature for the glyph.
    ///         Reverts: `ZeroRecipient`, `NotInscribed`, `Burned`,
    ///         `Unauthorized`, `TransferCountOverflow`.
    /// @param to Recipient.
    /// @param id Glyph ID.
    function transfer(address to, uint256 id) external {
        _transferGlyph(id, msg.sender, to);
    }

    /// @notice Move glyphs owned by `msg.sender` to `to`. ABI twin of raw op `0x02`.
    /// @dev    Atomic: reverts the whole batch if any glyph fails.
    /// @param to  Recipient.
    /// @param ids Glyph IDs to move, at least one.
    function transfer(address to, uint256[] calldata ids) external {
        _transferMany(ids, msg.sender, to);
    }

    /// @notice Burn one glyph owned by `msg.sender`.
    /// @dev    The slot stays: `exists` remains true, `burned` becomes true,
    ///         the owner ID becomes 0, `transferCount` +1, and every transfer
    ///         path reverts `Burned` from now on. Emits `GlyphTransfer(id, owner, 0x0)`.
    ///         Reverts: `NotInscribed`, `Burned`, `Unauthorized`, `TransferCountOverflow`.
    /// @param id Glyph ID.
    function burn(uint256 id) external {
        _burnGlyph(id, msg.sender);
        _countBurns(1);
    }

    /// @notice Burn glyphs owned by `msg.sender`. ABI twin of raw op `0x04`.
    /// @dev    Atomic; `stats` written once.
    /// @param ids Glyph IDs to burn, at least one.
    function burn(uint256[] calldata ids) external {
        uint256 count = ids.length;
        if (count == 0) {
            revert InvalidCalldata();
        }

        for (uint256 i = 0; i < count; ++i) {
            _burnGlyph(ids[i], msg.sender);
        }

        _countBurns(count);
    }

    // ──────────────────────────────────────────────────────────────
    //  Signed transfers (EIP-712, EOA + ERC-1271)
    // ──────────────────────────────────────────────────────────────

    /// @notice Move one glyph with the owner's signature; anyone may relay.
    /// @dev    Typed data `Transfer(uint256 glyphId,uint32 nonce,address to,uint256 deadline)`
    ///         with `nonce = transferCount(id)` at signing time.
    ///         Reverts: `NotInscribed`, `Burned`, `Unauthorized` (`from` is not
    ///         the owner), `SignatureExpired`, `InvalidSignature`,
    ///         `ZeroRecipient`, `TransferCountOverflow`.
    /// @param from       Current owner and signer.
    /// @param recipient  Recipient, as signed.
    /// @param id         Glyph ID.
    /// @param deadline   Last valid `block.timestamp`, inclusive.
    /// @param signature  ECDSA (65 or 64 bytes) or ERC-1271 signature by `from`.
    function transferWithSig(
        address from,
        address recipient,
        uint256 id,
        uint256 deadline,
        bytes calldata signature
    ) external {
        uint32 nonce = _transferNonce(id, from);
        bytes32 structHash =
            keccak256(abi.encode(TRANSFER_TYPEHASH, id, nonce, recipient, deadline));

        _verifySignature(from, structHash, deadline, signature);
        _transferGlyph(id, from, recipient);
    }

    /// @notice Move one glyph as the operator the owner authorized; the
    ///         operator picks the recipient (escrow-less marketplaces).
    /// @dev    Typed data `Authorize(uint256 glyphId,uint32 nonce,address operator,uint256 deadline)`
    ///         with `operator = msg.sender` and `nonce = transferCount(id)` at
    ///         signing time. Same reverts as `transferWithSig`; a caller other
    ///         than the signed operator fails with `InvalidSignature`.
    /// @param from      Current owner and signer.
    /// @param to        Recipient, chosen by the operator.
    /// @param id        Glyph ID.
    /// @param deadline  Last valid `block.timestamp`, inclusive.
    /// @param signature ECDSA (65 or 64 bytes) or ERC-1271 signature by `from`.
    function transferWithAuth(
        address from,
        address to,
        uint256 id,
        uint256 deadline,
        bytes calldata signature
    ) external {
        uint32 nonce = _transferNonce(id, from);
        address operator = msg.sender;
        bytes32 structHash =
            keccak256(abi.encode(AUTHORIZE_TYPEHASH, id, nonce, operator, deadline));

        _verifySignature(from, structHash, deadline, signature);
        _transferGlyph(id, from, to);
    }

    /// @notice Batch `transferWithSig`: one signature over many glyphs.
    /// @dev    Typed data `BatchTransfer(uint256[] glyphIds,uint32[] nonces,address to,uint256 deadline)`
    ///         with `nonces[i] = transferCount(ids[i])` at signing time and
    ///         standard EIP-712 array hashing. Atomic.
    /// @param from       Current owner of every glyph and signer.
    /// @param recipient  Recipient, as signed.
    /// @param ids        Glyph IDs, at least one.
    /// @param deadline   Last valid `block.timestamp`, inclusive.
    /// @param signature  ECDSA (65 or 64 bytes) or ERC-1271 signature by `from`.
    function transferWithSig(
        address from,
        address recipient,
        uint256[] calldata ids,
        uint256 deadline,
        bytes calldata signature
    ) external {
        bytes32 noncesHash = _transferNoncesHash(ids, from);
        bytes32 structHash = keccak256(
            abi.encode(
                BATCH_TRANSFER_TYPEHASH,
                keccak256(abi.encodePacked(ids)),
                noncesHash,
                recipient,
                deadline
            )
        );

        _verifySignature(from, structHash, deadline, signature);
        _transferMany(ids, from, recipient);
    }

    /// @notice Batch `transferWithAuth`: one signature authorizes `msg.sender`
    ///         to move many glyphs to a recipient of its choice.
    /// @dev    Typed data `BatchAuthorize(uint256[] glyphIds,uint32[] nonces,address operator,uint256 deadline)`
    ///         with `operator = msg.sender`, `nonces[i] = transferCount(ids[i])`
    ///         at signing time and standard EIP-712 array hashing. Atomic.
    /// @param from      Current owner of every glyph and signer.
    /// @param to        Recipient, chosen by the operator.
    /// @param ids       Glyph IDs, at least one.
    /// @param deadline  Last valid `block.timestamp`, inclusive.
    /// @param signature ECDSA (65 or 64 bytes) or ERC-1271 signature by `from`.
    function transferWithAuth(
        address from,
        address to,
        uint256[] calldata ids,
        uint256 deadline,
        bytes calldata signature
    ) external {
        bytes32 noncesHash = _transferNoncesHash(ids, from);
        bytes32 structHash = keccak256(
            abi.encode(
                BATCH_AUTHORIZE_TYPEHASH,
                keccak256(abi.encodePacked(ids)),
                noncesHash,
                msg.sender,
                deadline
            )
        );

        _verifySignature(from, structHash, deadline, signature);
        _transferMany(ids, from, to);
    }

    // ──────────────────────────────────────────────────────────────
    //  Global stats
    // ──────────────────────────────────────────────────────────────

    /// @notice Total number of glyphs inscribed so far (also the latest glyph number).
    function glyphCount() external view returns (uint256) {
        return stats & NUMBER_MAX;
    }

    /// @notice Sum of all inscribed content sizes, in bytes.
    function totalInscribedSize() external view returns (uint256) {
        return (stats >> TOTAL_SIZE_SHIFT) & TOTAL_SIZE_MASK;
    }

    /// @notice Number of glyphs burned so far.
    function burnCount() external view returns (uint256) {
        return (stats >> BURN_COUNT_SHIFT) & NUMBER_MAX;
    }

    // ──────────────────────────────────────────────────────────────
    //  Glyph ID codec (pure — no storage reads)
    // ──────────────────────────────────────────────────────────────

    /// @notice The glyph ID `creator` gets for `content` — before or after inscribing.
    /// @param creator Creator address.
    /// @param content Content bytes.
    /// @return The `uint256` glyph ID: `creatorId(100) ‖ contentId(156)`.
    function glyphId(address creator, bytes calldata content) external pure returns (uint256) {
        return _glyphId(creator, uint256(keccak256(content)) & CONTENT_ID_MASK);
    }

    /// @notice Creator of a glyph, as its 100-bit salted creator ID (ID bits 156..255).
    /// @dev    Pure — decoded from the ID itself. Check a candidate address
    ///         with `isCreator(id, addr)`.
    /// @param id Glyph ID.
    function creatorOf(uint256 id) external pure returns (uint256) {
        return id >> CONTENT_ID_BITS;
    }

    /// @notice Content ID of a glyph: the low 156 bits of `keccak256(content)` (ID bits 0..155).
    /// @param id Glyph ID.
    function contentIdOf(uint256 id) external pure returns (uint256) {
        return id & CONTENT_ID_MASK;
    }

    /// @notice Whether `account` is the creator encoded in the glyph ID.
    /// @dev    Pure: recomputes the salted creator hash. False for `address(0)`.
    /// @param id      Glyph ID.
    /// @param account Candidate creator address.
    function isCreator(uint256 id, address account) external pure returns (bool) {
        return _isCreator(id, _creatorId(account, id & CONTENT_ID_MASK));
    }

    /// @notice Whether `creatorId` (as returned by `creatorOf`) is the creator
    ///         encoded in the glyph ID.
    /// @param id        Glyph ID.
    /// @param creatorId Candidate 100-bit creator ID.
    function isCreator(uint256 id, uint256 creatorId) external pure returns (bool) {
        return _isCreator(id, creatorId);
    }

    /// @notice Whether `content` is the content the glyph ID commits to.
    /// @param id      Glyph ID.
    /// @param content Candidate content bytes.
    function verifyContent(uint256 id, bytes calldata content) external pure returns (bool) {
        return (uint256(keccak256(content)) & CONTENT_ID_MASK) == (id & CONTENT_ID_MASK);
    }

    // ──────────────────────────────────────────────────────────────
    //  Per-glyph state
    // ──────────────────────────────────────────────────────────────

    /// @notice Whether the glyph has been inscribed. Stays true after a burn.
    /// @param id Glyph ID.
    function exists(uint256 id) external view returns (bool) {
        return glyphs[id] & EXISTS_FLAG != 0;
    }

    /// @notice Whether the glyph has been burned.
    /// @param id Glyph ID.
    function isBurned(uint256 id) external view returns (bool) {
        return glyphs[id] & BURNED_FLAG != 0;
    }

    /// @notice Alias of `isBurned`.
    /// @param id Glyph ID.
    function isBurnt(uint256 id) external view returns (bool) {
        return glyphs[id] & BURNED_FLAG != 0;
    }

    /// @notice Whether the glyph is inscribed and not burned.
    /// @param id Glyph ID.
    function isAlive(uint256 id) external view returns (bool) {
        return _isAlive(glyphs[id]);
    }

    /// @notice `isAlive` for many glyphs at once.
    /// @param ids Glyph IDs.
    /// @return alive One flag per ID, in order.
    function isAlive(uint256[] calldata ids) external view returns (bool[] memory alive) {
        uint256 count = ids.length;
        alive = new bool[](count);

        for (uint256 i = 0; i < count; ++i) {
            alive[i] = _isAlive(glyphs[ids[i]]);
        }
    }

    /// @notice Sequential, 1-based glyph number (mint order). 0 for unknown glyphs.
    /// @param id Glyph ID.
    function glyphNumber(uint256 id) external view returns (uint256) {
        return (glyphs[id] >> NUMBER_SHIFT) & NUMBER_MAX;
    }

    /// @notice Block number at inscription. 0 for unknown glyphs.
    /// @dev    Stored relative to `DEPLOY_BLOCK` in 31 bits, so it wraps
    ///         every 2^31 blocks; consumers subtract modulo 2^31.
    /// @param id Glyph ID.
    function createdBlock(uint256 id) external view returns (uint256) {
        return _absoluteBlock(glyphs[id], CREATED_BLOCK_SHIFT);
    }

    /// @notice Block number at which the current owner acquired the glyph —
    ///         set on inscribe, on every transfer, and on burn (so it records
    ///         the burn block). 0 for unknown glyphs.
    /// @dev    Same encoding and wrap as `createdBlock`.
    /// @param id Glyph ID.
    function ownerSinceBlock(uint256 id) external view returns (uint256) {
        return _absoluteBlock(glyphs[id], OWNER_SINCE_BLOCK_SHIFT);
    }

    /// @notice Number of times the glyph moved (burn included). Doubles as
    ///         the EIP-712 `nonce` for signed transfers.
    /// @dev    Returns 0 for unknown glyphs and for never-transferred glyphs.
    /// @param id Glyph ID.
    function transferCount(uint256 id) external view returns (uint32) {
        return _transferCountOf(glyphs[id]);
    }

    /// @notice Current owner of a glyph, as its 130-bit salted owner ID
    ///         (`keccak256(addr ‖ glyphId) & CURRENT_OWNER_MASK | 1`).
    /// @dev    Storage never holds the raw address; resolve the ID off-chain
    ///         via `GlyphTransfer`, or check a candidate with `isOwner`.
    ///         Returns 0 for burned glyphs. Reverts `NotInscribed` only for
    ///         glyphs that were never inscribed.
    /// @param id Glyph ID.
    /// @return 130-bit owner ID, or 0 once burned.
    function ownerOf(uint256 id) external view returns (uint256) {
        uint256 ownership = glyphs[id];
        if (ownership & EXISTS_FLAG == 0) {
            revert NotInscribed(id);
        }

        return ownership & CURRENT_OWNER_MASK;
    }

    /// @notice Whether `account` currently owns the glyph.
    /// @dev    False for unknown and burned glyphs, and for `address(0)`.
    /// @param id      Glyph ID.
    /// @param account Candidate owner address.
    function isOwner(uint256 id, address account) external view returns (bool) {
        return _isOwner(glyphs[id], _currentOwnerId(account, id));
    }

    /// @notice Whether `ownerId` (as returned by `ownerOf`) currently owns the glyph.
    /// @dev    False for unknown and burned glyphs, and for `ownerId == 0`.
    /// @param id      Glyph ID.
    /// @param ownerId Candidate 130-bit owner ID.
    function isOwner(uint256 id, uint256 ownerId) external view returns (bool) {
        return _isOwner(glyphs[id], ownerId);
    }

    /// @dev Whether `ownerId` is the current owner field of an ownership word.
    function _isOwner(uint256 ownership, uint256 ownerId) internal pure returns (bool) {
        return ownerId != 0 && (ownership & CURRENT_OWNER_MASK) == ownerId;
    }

    /// @dev Shared body for both `isCreator` overloads.
    function _isCreator(uint256 id, uint256 creatorId) internal pure returns (bool) {
        return creatorId != 0 && (id >> CONTENT_ID_BITS) == creatorId;
    }

    /// @dev `EXISTS` set and `BURNED` clear.
    function _isAlive(uint256 ownership) internal pure returns (bool) {
        return ownership & (EXISTS_FLAG | BURNED_FLAG) == EXISTS_FLAG;
    }

    /// @dev Absolute block number of the block field at `shift`; 0 for a zero word.
    function _absoluteBlock(uint256 ownership, uint256 shift) internal view returns (uint256) {
        if (ownership == 0) {
            return 0;
        }

        return DEPLOY_BLOCK + ((ownership >> shift) & BLOCK_MASK);
    }

    // ──────────────────────────────────────────────────────────────
    //  Raw op parsers (reached only via `fallback`)
    // ──────────────────────────────────────────────────────────────

    /// @dev Op `0x01`. Calldata: `0x01 ‖ initialOwner(20) ‖ content`.
    ///      Returns `(uint256 glyphId, bytes32 contentId)` as two ABI words.
    ///      Reverts: `InvalidCalldata`, plus anything from `_inscribeOne`.
    function _inscribe() internal {
        if (msg.data.length < 21) {
            revert InvalidCalldata();
        }

        address initialOwner;
        assembly {
            initialOwner := shr(96, calldataload(1))
        }
        bytes calldata content = msg.data[21:];

        uint256 number = _reserveGlyphs(1, content.length);
        bytes32 contentId = keccak256(content);
        uint256 id = _inscribeOne(msg.sender, initialOwner, contentId, content.length, number);

        assembly {
            mstore(0x00, id)
            mstore(0x20, contentId)
            return(0x00, 0x40)
        }
    }

    /// @dev Op `0x03`. Calldata: `0x03 ‖ initialOwner(20) ‖ (size(2) ‖ content(size))+`,
    ///      at least one item; `size` is a big-endian `uint16`. Returns the
    ///      new glyph IDs packed as 32 bytes each (the format ops `0x02` /
    ///      `0x04` take). Reverts: `InvalidCalldata` when a size header runs
    ///      past the end of calldata, plus anything from `_inscribeOne`.
    function _inscribeBatch() internal {
        uint256 length = msg.data.length;
        if (length < 23) {
            revert InvalidCalldata();
        }

        address initialOwner;
        assembly {
            initialOwner := shr(96, calldataload(1))
        }

        // Pass 1: validate the framing, count the items, sum the sizes.
        uint256 count = 0;
        uint256 totalSize = 0;
        for (uint256 offset = 21; offset < length; ++count) {
            uint256 size = _batchItemSize(offset);
            offset += 2 + size;
            if (offset > length) {
                revert InvalidCalldata();
            }
            totalSize += size;
        }

        // Pass 2: inscribe.
        uint256 number = _reserveGlyphs(count, totalSize);
        uint256[] memory ids = new uint256[](count);
        uint256 cursor = 21;

        for (uint256 i = 0; i < count; ++i) {
            uint256 size = _batchItemSize(cursor);
            cursor += 2;
            bytes calldata content = msg.data[cursor:cursor + size];
            cursor += size;

            ids[i] = _inscribeOne(msg.sender, initialOwner, keccak256(content), size, number + i);
        }

        assembly {
            return(add(ids, 0x20), mul(count, 0x20))
        }
    }

    /// @dev Big-endian `uint16` size header at `offset` of an op `0x03`
    ///      payload. Reverts `InvalidCalldata` if the header is truncated.
    function _batchItemSize(uint256 offset) internal pure returns (uint256 size) {
        if (offset + 2 > msg.data.length) {
            revert InvalidCalldata();
        }

        assembly {
            size := shr(240, calldataload(offset))
        }
    }

    /// @dev Op `0x02`. Calldata: `0x02 ‖ recipient(20) ‖ glyphId(32) × N`,
    ///      N ≥ 1. Moves every listed glyph from `msg.sender` to
    ///      `recipient`; the whole batch reverts if any glyph fails.
    ///      Reverts: `InvalidCalldata` on bad length / alignment, plus
    ///      anything from `_transferGlyph`.
    function _transfer() internal {
        uint256 length = msg.data.length;
        if (length < 53 || (length - 21) % 32 != 0) {
            revert InvalidCalldata();
        }

        address recipient;
        assembly {
            recipient := shr(96, calldataload(1))
        }

        for (uint256 offset = 21; offset < length; offset += 32) {
            uint256 id;
            assembly {
                id := calldataload(offset)
            }

            _transferGlyph(id, msg.sender, recipient);
        }
    }

    /// @dev Op `0x04`. Calldata: `0x04 ‖ glyphId(32) × N`, N ≥ 1. Burns every
    ///      listed glyph owned by `msg.sender`; atomic; `stats` written once.
    ///      Reverts: `InvalidCalldata` on bad length / alignment, plus
    ///      anything from `_burnGlyph`.
    function _burn() internal {
        uint256 length = msg.data.length;
        if (length < 33 || (length - 1) % 32 != 0) {
            revert InvalidCalldata();
        }

        for (uint256 offset = 1; offset < length; offset += 32) {
            uint256 id;
            assembly {
                id := calldataload(offset)
            }

            _burnGlyph(id, msg.sender);
        }

        _countBurns((length - 1) / 32);
    }

    // ──────────────────────────────────────────────────────────────
    //  Shared write internals
    // ──────────────────────────────────────────────────────────────

    /// @dev Reserves `count` sequential glyph numbers and accounts `totalSize`
    ///      bytes: the one `stats` write of an inscribe, done before any glyph
    ///      is written. Returns the first number.
    ///      Reverts `CountOverflow` if the 33-bit counter cannot fit them.
    ///      The size field cannot overflow: 2^33 glyphs × 24,200 bytes < 2^48.
    function _reserveGlyphs(uint256 count, uint256 totalSize) internal returns (uint256 first) {
        uint256 current = stats;
        uint256 inscribed = current & NUMBER_MAX;
        if (count > NUMBER_MAX - inscribed) {
            revert CountOverflow();
        }

        uint256 newSize = ((current >> TOTAL_SIZE_SHIFT) & TOTAL_SIZE_MASK) + totalSize;
        stats = (current & (NUMBER_MAX << BURN_COUNT_SHIFT)) | (inscribed + count)
            | (newSize << TOTAL_SIZE_SHIFT);

        first = inscribed + 1;
    }

    /// @dev Adds `count` to the burn counter. Cannot overflow: a glyph burns
    ///      at most once, so `burnCount <= glyphCount <= NUMBER_MAX`.
    function _countBurns(uint256 count) internal {
        stats += count << BURN_COUNT_SHIFT;
    }

    /// @dev Sum of the content lengths of an ABI batch.
    function _totalLength(bytes[] calldata contents) internal pure returns (uint256 total) {
        uint256 count = contents.length;
        for (uint256 i = 0; i < count; ++i) {
            total += contents[i].length;
        }
    }

    /// @dev Inscribes glyph `number` for `creator` with first owner
    ///      `initialOwner`: derives the content-keyed ID, stores the ownership
    ///      word with `EXISTS`, emits `GlyphTransfer(id, 0x0, initialOwner)`.
    ///      Does not touch `stats`.
    ///      Reverts: `ZeroOwner`, `ContentTooLarge`, `AlreadyInscribed`.
    function _inscribeOne(
        address creator,
        address initialOwner,
        bytes32 contentId,
        uint256 size,
        uint256 number
    ) internal returns (uint256 id) {
        if (initialOwner == address(0)) {
            revert ZeroOwner();
        }
        if (size > MAX_CONTENT_SIZE) {
            revert ContentTooLarge(size);
        }

        id = _glyphId(creator, uint256(contentId) & CONTENT_ID_MASK);
        if (glyphs[id] != 0) {
            revert AlreadyInscribed(id);
        }

        uint256 blockField = _relativeBlock();
        glyphs[id] = _currentOwnerId(initialOwner, id) | (number << NUMBER_SHIFT)
            | (blockField << CREATED_BLOCK_SHIFT) | (blockField << OWNER_SINCE_BLOCK_SHIFT)
            | EXISTS_FLAG;

        emit GlyphTransfer(id, address(0), initialOwner);
    }

    /// @dev Moves every glyph in `ids` (at least one) from `from` to `to`.
    ///      Reverts `InvalidCalldata` on an empty list, plus anything from
    ///      `_transferGlyph`.
    function _transferMany(uint256[] calldata ids, address from, address to) internal {
        uint256 count = ids.length;
        if (count == 0) {
            revert InvalidCalldata();
        }

        for (uint256 i = 0; i < count; ++i) {
            _transferGlyph(ids[i], from, to);
        }
    }

    /// @dev Moves one glyph from `from` to `to`: new current owner ID,
    ///      owner-since block refreshed, transfer count +1, number / created
    ///      block / flags kept. Emits `GlyphTransfer(id, from, to)`.
    ///      Reverts: `ZeroRecipient`, `NotInscribed`,
    ///      `Burned`, `Unauthorized`, `TransferCountOverflow`.
    function _transferGlyph(uint256 id, address from, address to) internal {
        if (to == address(0)) {
            revert ZeroRecipient();
        }

        uint256 ownership = _ownershipOf(id, _currentOwnerId(from, id));
        glyphs[id] = _movedWord(id, ownership) | _currentOwnerId(to, id);

        emit GlyphTransfer(id, from, to);
    }

    /// @dev Burns one glyph owned by `from`: owner ID cleared, `BURNED` set,
    ///      owner-since block refreshed, transfer count +1. Emits
    ///      `GlyphTransfer(id, from, 0x0)`. Does not touch `stats`.
    ///      Reverts: `NotInscribed`, `Burned`, `Unauthorized`, `TransferCountOverflow`.
    function _burnGlyph(uint256 id, address from) internal {
        uint256 ownership = _ownershipOf(id, _currentOwnerId(from, id));
        glyphs[id] = _movedWord(id, ownership) | BURNED_FLAG;

        emit GlyphTransfer(id, from, address(0));
    }

    /// @dev The ownership word after one move, owner field left empty:
    ///      number / created block / flags kept, owner-since block set to
    ///      now, transfer count +1. Reverts `TransferCountOverflow` at max.
    function _movedWord(uint256 id, uint256 ownership) internal view returns (uint256) {
        uint256 transfers = _transferCountOf(ownership);
        if (transfers == TRANSFER_COUNT_MAX) {
            revert TransferCountOverflow(id);
        }
        unchecked {
            ++transfers;
        }

        return (ownership & KEPT_ON_MOVE) | (_relativeBlock() << OWNER_SINCE_BLOCK_SHIFT)
            | (transfers << TRANSFER_COUNT_SHIFT);
    }

    /// @dev Ownership word of `id`, provided it exists, is not burned, and is
    ///      held by `ownerId`. Reverts: `NotInscribed`, `Burned`, `Unauthorized`.
    function _ownershipOf(uint256 id, uint256 ownerId) internal view returns (uint256 ownership) {
        ownership = glyphs[id];

        if (ownership & EXISTS_FLAG == 0) {
            revert NotInscribed(id);
        }
        if (ownership & BURNED_FLAG != 0) {
            revert Burned(id);
        }
        if ((ownership & CURRENT_OWNER_MASK) != ownerId) {
            revert Unauthorized();
        }
    }

    /// @dev Transfer count field of an ownership word.
    function _transferCountOf(uint256 ownership) internal pure returns (uint32) {
        return uint32((ownership >> TRANSFER_COUNT_SHIFT) & TRANSFER_COUNT_MAX);
    }

    /// @dev Current block relative to `DEPLOY_BLOCK`, truncated to `BLOCK_BITS`.
    function _relativeBlock() internal view returns (uint256) {
        return (block.number - DEPLOY_BLOCK) & BLOCK_MASK;
    }

    // ──────────────────────────────────────────────────────────────
    //  Signature internals
    // ──────────────────────────────────────────────────────────────

    /// @dev EIP-712 `nonce` for `id`: its transfer count, after checking that
    ///      `owner` holds it. Reverts: `NotInscribed`, `Burned`, `Unauthorized`.
    function _transferNonce(uint256 id, address owner) internal view returns (uint32) {
        return _transferCountOf(_ownershipOf(id, _currentOwnerId(owner, id)));
    }

    /// @dev EIP-712 hash of `uint32[] nonces` for `ids` (at least one), each
    ///      checked against `owner`. Reverts `InvalidCalldata` on an empty
    ///      list, plus anything from `_transferNonce`.
    function _transferNoncesHash(uint256[] calldata ids, address owner)
        internal
        view
        returns (bytes32)
    {
        uint256 count = ids.length;
        if (count == 0) {
            revert InvalidCalldata();
        }

        uint32[] memory nonces = new uint32[](count);
        for (uint256 i = 0; i < count; ++i) {
            nonces[i] = _transferNonce(ids[i], owner);
        }

        return keccak256(abi.encodePacked(nonces));
    }

    /// @dev Checks `deadline`, then `signature` by `signer` over the EIP-712
    ///      digest of `structHash`. Signers without code: ECDSA via
    ///      OpenZeppelin (rejects high `s`; 65-byte or 64-byte EIP-2098).
    ///      Signers with code: ERC-1271 `isValidSignature`.
    ///      Reverts: `SignatureExpired`, `InvalidSignature`.
    function _verifySignature(
        address signer,
        bytes32 structHash,
        uint256 deadline,
        bytes calldata signature
    ) internal view {
        // Deadlines are wall-clock by definition; validator drift of a few seconds is fine.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) {
            revert SignatureExpired();
        }

        bytes32 digest = _hashTypedData(structHash);
        bool valid = signer.code.length == 0
            ? _isSignedBy(signer, digest, signature)
            : SignatureChecker.isValidERC1271SignatureNowCalldata(signer, digest, signature);
        if (!valid) {
            revert InvalidSignature();
        }
    }

    /// @dev ECDSA check for signers without code, via OpenZeppelin
    ///      `ECDSA.tryRecover`: 65-byte `(r, s, v)` or 64-byte EIP-2098
    ///      `(r, vs)`, high `s` rejected. Recovery errors never match, so a
    ///      zero `signer` cannot be satisfied by a failed recovery.
    function _isSignedBy(address signer, bytes32 digest, bytes calldata signature)
        internal
        pure
        returns (bool)
    {
        address recovered;
        ECDSA.RecoverError err;
        if (signature.length == 64) {
            (recovered, err,) =
                ECDSA.tryRecover(digest, bytes32(signature[0:32]), bytes32(signature[32:64]));
        } else {
            (recovered, err,) = ECDSA.tryRecoverCalldata(digest, signature);
        }

        return err == ECDSA.RecoverError.NoError && recovered == signer;
    }

    /// @dev EIP-712 domain: `("Glyph Kernel", "2")`; chainId and
    ///      verifyingContract are added by solady's `EIP712`.
    function _domainNameAndVersion()
        internal
        pure
        override
        returns (string memory name, string memory version)
    {
        name = "Glyph Kernel";
        version = "2";
    }

    // ──────────────────────────────────────────────────────────────
    //  Address → ID helpers
    // ──────────────────────────────────────────────────────────────

    /// @dev Glyph ID for `creator` and a 156-bit `contentId`:
    ///      `creatorId(creator, contentId) << 156 | contentId`.
    function _glyphId(address creator, uint256 contentId) internal pure returns (uint256) {
        return (_creatorId(creator, contentId) << CONTENT_ID_BITS) | contentId;
    }

    /// @dev 100-bit creator ID, salted with the content:
    ///      `keccak256(account ‖ contentId) & CREATOR_MASK | 1`; 0 for `address(0)`.
    function _creatorId(address account, uint256 contentId) internal pure returns (uint256) {
        if (account == address(0)) {
            return 0;
        }

        return (uint256(keccak256(abi.encodePacked(account, contentId))) & CREATOR_MASK) | 1;
    }

    /// @dev Current owner ID, salted with the glyph:
    ///      `keccak256(account ‖ glyphId) & CURRENT_OWNER_MASK | 1`; 0 for `address(0)`.
    function _currentOwnerId(address account, uint256 id) internal pure returns (uint256) {
        if (account == address(0)) {
            return 0;
        }

        return (uint256(keccak256(abi.encodePacked(account, id))) & CURRENT_OWNER_MASK) | 1;
    }
}
