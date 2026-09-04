Project: glyph-protocol — Glyph Kernel, minimal on-chain inscription protocol (Solidity, Foundry)
Path: projects/glyph-protocol

## Goal

Add collections and the content tag to the v3 kernel: `collectionMint`, `contentOf(id, collection)`, and a 3-byte tag prefix in the glyph ID.

## Context

- v3 is built, tested, committed (c8bd697 and follow-ups). `vp run --filter glyph-protocol check` is green.
- `docs/collections.md` — user guide for the three collection flows. `docs/kernel-collection-methods.md` — method snippets for `collectionMint` and `contentOf`. Read both first; they carry most of the detail.
- Toolchain and rules as before: forge 1.7, solc 0.8.30, `deny = "warnings"`, scripts via `vp run --filter glyph-protocol <fmt|lint|test|build|check>`, `selectors` guard (no selector may start with `0x01..0x04`), `gitswitch switch tunnckoCore` before committing.

## What's Left

1. Tag prefix. The first 3 bytes of every content are the tag; the kernel strips them before hashing. New ID layout: `tag (24) ‖ creatorId (96) ‖ contentId (136)`, where `contentId` is the low 136 bits of `keccak256(payload)` (content minus the 3 tag bytes) and the creator salt is the ID with the creator field zeroed: `(tag << 136) | contentId`. Content shorter than 3 bytes: missing tag bytes are zero; empty content → tag 0. Uniqueness stays creator + content (the tag is part of the content bytes). Add `tagOf(id)`; `glyphId` and `verifyContent` keep taking the full content as sent; the returned `bytes32 contentId` is `keccak256(payload)`. The `Inscribe` struct becomes `Inscribe(uint24 tag,bytes32 contentId,address initialOwner,uint256 deadline)` so the signer commits to the tag. Tag meanings are convention only (0 = untagged); the kernel never interprets them.
2. `collectionMint`. Payable; the creator signs one `CollectionMint(bytes32 contentRoot,uint256 price,uint256 deadline,bytes32 salt)` config (EOA or ERC-1271); `contentRoot == 0` accepts any content, otherwise Merkle proof via OZ `MerkleProof`; the kernel checks `msg.value == price`, inscribes with the signer as creator, forwards the value to the creator, holds nothing. Snippets in `docs/kernel-collection-methods.md`; align the Merkle leaves with the payload-hash rule from item 1.
3. `contentOf(id, collection)`. View: `NotInscribed` / `NotCreator` checks, then staticcall `IGlyphCollection.contentOf(id)`. Snippet in the same doc.
4. Update tests, README, both docs; regenerate `.gas-snapshot`; `check` green; `selectors` still green.

## Gotchas

- Test suites are split into five files because of the 49 KB initcode limit; a new suite may be needed.
- Any new public method gets a selector; run `selectors` early.
- The docs snippets predate item 1; treat the layout in this file as the source of truth where they disagree.
