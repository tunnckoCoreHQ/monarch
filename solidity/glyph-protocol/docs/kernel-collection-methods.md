# Kernel methods for collections

Design note for the kernel: `collectionMint` and `contentOf(id, collection)`. Not in `src/GlyphKernel.sol` yet. No storage, no ID or slot changes. Selectors must avoid `0x01..0x04` (`vp run --filter glyph-protocol selectors`). The user-facing flows are in `collections.md`.

### `collectionMint`

```solidity
/// @notice A creator-signed drop configuration. Signed once, reused by every minter.
/// @dev    EIP-712 `CollectionMint(bytes32 contentRoot,uint256 price,uint256 deadline,bytes32 salt)`.
///         `contentRoot == 0` = any content is accepted (seed-based / generative drops);
///         otherwise `keccak256(content)` must be a leaf (fixed set of pieces = the supply).
struct MintConfig {
    bytes32 contentRoot;
    uint256 price;
    uint256 deadline;
    bytes32 salt; // distinguishes drops of the same creator
}

bytes32 private constant MINT_TYPEHASH =
    keccak256("CollectionMint(bytes32 contentRoot,uint256 price,uint256 deadline,bytes32 salt)");

error WrongPrice(uint256 expected, uint256 sent);
error NotInDrop(bytes32 contentId);
error PayoutFailed(address creator);

/// @notice Mint a glyph of `creator`'s drop, paying `cfg.price` to the creator.
/// @dev    The creator is the signer of `cfg`: an EOA (canonical ECDSA over the config) or a
///         contract (ERC-1271 — `signature` is then whatever the collection wants to check;
///         it receives the config digest and can apply its own view rules). The kernel
///         verifies the signature, the price, optional content membership, inscribes with
///         `creator` as creator, emits `GlyphTransfer(id, 0x0, to)`, then forwards
///         `msg.value` to `creator` (EOA wallet, or the collection's `receive()`, which may
///         count supply / enforce anything stateful and revert to refuse).
///         Reverts: `SignatureExpired`, `InvalidSignature`, `WrongPrice`, `NotInDrop`,
///         `ZeroOwner`, `ContentTooLarge`, `AlreadyInscribed`, `CountOverflow`, `PayoutFailed`.
/// @param creator   Signer of `cfg`; becomes the glyph's creator.
/// @param cfg       The drop config exactly as signed.
/// @param signature Creator's signature over `cfg` (65/64-byte ECDSA) or ERC-1271 payload.
/// @param to        First owner (usually `msg.sender`).
/// @param content   Content bytes, or a seed for generative drops.
/// @param proof     Merkle proof of `keccak256(content)` in `cfg.contentRoot`; empty if root is 0.
function collectionMint(
    address creator,
    MintConfig calldata cfg,
    bytes calldata signature,
    address to,
    bytes calldata content,
    bytes32[] calldata proof
) external payable returns (uint256 id, bytes32 contentId) {
    bytes32 structHash = keccak256(abi.encode(
        MINT_TYPEHASH,
        cfg.contentRoot,
        cfg.price,
        cfg.deadline,
        cfg.salt
    ));

    // existing internal: EOA / 1271
    _verifySignature(creator, structHash, cfg.deadline, signature);

    if (msg.value != cfg.price) {
        revert WrongPrice(cfg.price, msg.value);
    }

    contentId = keccak256(content);
    if (cfg.contentRoot != 0 && !MerkleProof.verifyCalldata(proof, cfg.contentRoot, contentId)) {
        revert NotInDrop(contentId);
    }

    uint256 number = _reserveGlyphs(1, content.length);

    // slot + event, creator = signer
    id = _inscribeOne(creator, to, contentId, content.length, number);
    if (msg.value != 0) {
        (bool ok,) = creator.call{value: msg.value}("");
        if (!ok) {
            revert PayoutFailed(creator);
        }
    }
}
```

`MerkleProof` is OpenZeppelin's (already a dependency). Order is checks → effects → the one external call: a collection re-entering from `receive()` sees the slot and `stats` already written.

### `contentOf`

```solidity
/// @dev Collections that derive content from the glyph ID implement this.
interface IGlyphCollection {
    function contentOf(uint256 glyphId) external view returns (bytes memory);
}

error NotCreator(uint256 glyphId, address collection);

/// @notice Content of `id` as rendered by the collection that created it.
/// @dev    Proves `collection` is the creator (pure, salted hash) before asking it, so the
///         bytes are trust-anchored to the ID. The `collection` parameter is needed because
///         the ID carries a salted hash of the creator, not the address. Reverts
///         `NotInscribed`, `NotCreator`, or whatever the collection reverts with.
function contentOf(uint256 id, address collection) external view returns (bytes memory) {
    if (glyphs[id] & EXISTS_FLAG == 0) {
        revert NotInscribed(id);
    }
    if (!_isCreator(id, _creatorId(collection, id & CONTENT_ID_MASK))) {
        revert NotCreator(id, collection);
    }

    return IGlyphCollection(collection).contentOf(id);
}
```
