# Glyph Kernel

**Glyph 2026** — a minimal on-chain inscription protocol.
Content goes on-chain in calldata; the kernel keeps a compact, fully
queryable ownership record in EVM state. **One storage slot per glyph + one
global `stats` slot.** Raw op-byte writes for the cheapest path, a thin ABI on
top for tooling, EIP-712 signed inscribes and transfers for relayers and
marketplaces, explicit burn, one event. No admin.

### Why, vs. Ethscriptions

Same model (content in calldata, cheap, permanent), but it fixes the things
that make Ethscriptions painful:

- **One contract, one event.** `GlyphTransfer` logs (mint from `0x0`, burn to
  `0x0`) mean a subgraph, substream, or any log-based indexer syncs the whole
  protocol in minutes. No custom indexer scanning every EOA→EOA transaction.
- **Ownership lives in state, not in a replayed history.** `isOwner(id, addr)`
  is a single `eth_call`; transfers are one SSTORE, atomic, batchable, and
  revert on bad input instead of silently producing "invalid" transfers.
- **IDs are content-addressed per creator.** The glyph ID is derived from the
  creator and the content bytes, so it is known before the transaction lands,
  identical on every chain, and a copier gets a different ID — no mempool
  sniping, no duplicate-inscription races.
- **Provenance is on-chain and verifiable** — creator, mint order, created
  block, how long the current owner has held it, transfer count — in the same
  slot, readable by other contracts.
- **Signed writes, no escrow.** The creator signs once and a relayer mints; the
  owner signs once and a relayer or an authorized operator moves the glyph. The
  per-glyph `transferCount` is the nonce, so there is no nonce storage and every
  transfer cancels every outstanding signature for that glyph. Works for EOAs
  and ERC-1271 wallets.

- `GlyphKernel.sol` — the contract (Solidity `^0.8.30`, ~1250 lines incl. NatSpec;
  depends on solady `EIP712` + OpenZeppelin `ECDSA` / `SignatureChecker`, compiled in)

---

## How it works

Every write exists as a raw op-byte payload (handled by `fallback`) and as an
ABI method. Same internals, same state, same event.

|                     | Raw (`tx.data`)                                                                                                                                                                                                                                                                                                 | ABI                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Inscribe**        | `0x01 ‖ initialOwner(20) ‖ content(≤ 24 200)` → returns `(uint256 glyphId, bytes32 contentId)`; `msg.sender` is the creator                                                                                                                                                                                     | `inscribe(address initialOwner, bytes content) → (uint256 id, bytes32 contentId)`                                                          |
| **Batch inscribe**  | `0x03 ‖ initialOwner(20) ‖ (size(2) ‖ content)+` → returns the IDs packed as 32 bytes each                                                                                                                                                                                                                      | `inscribe(address initialOwner, bytes[] contents) → uint256[] ids` · `inscribe(address[] initialOwners, bytes[] contents) → uint256[] ids` |
| **Signed inscribe** | —                                                                                                                                                                                                                                                                                                               | `inscribeWithSig(creator, initialOwner, content, deadline, sig)`; the signer is the creator                                                |
| **Transfer**        | `0x02 ‖ recipient(20) ‖ glyphId(32) × N` → moves N glyphs from `msg.sender`                                                                                                                                                                                                                                     | `transfer(address to, uint256 id)` · `transfer(address to, uint256[] ids)`                                                                 |
| **Signed transfer** | —                                                                                                                                                                                                                                                                                                               | `transferWithSig` / `transferWithAuth`, single or batch (see below)                                                                        |
| **Burn**            | `0x04 ‖ glyphId(32) × N` → burns N glyphs owned by `msg.sender`                                                                                                                                                                                                                                                 | `burn(uint256 id)` · `burn(uint256[] ids)`                                                                                                 |
| **Content**         | on-chain in the inscribing tx's calldata (permanent, indexable); EVM state holds only the truncated `keccak256(content)` inside the ID, so other contracts see the commitment, not the bytes                                                                                                                    |                                                                                                                                            |
| **Identity**        | addresses are not kept in EVM state; every identity is a truncated, **salted** `keccak256 \| 1` — **100-bit creator ID** (salted with the content) in the glyph ID, **130-bit owner ID** (salted with the glyph ID) in the slot. Verifiable on-chain (`isCreator`, `isOwner`), resolvable off-chain from events |                                                                                                                                            |

Batches are atomic, emit one `GlyphTransfer` per glyph, and write `stats`
once. `size` in the raw batch is a big-endian `uint16`; the packed IDs it
returns are exactly the list ops `0x02` / `0x04` take.

### Glyph ID (`uint256`) is content-addressed per creator

```
bits 156..255   creator ID    (100)   uint100(keccak256(creator ‖ contentId)) | 1
bits   0..155   content ID    (156)   low 156 bits of keccak256(content)
```

`contentId` is hashed as a 32-byte word (`abi.encodePacked(address, uint256)`).
The ID is the mapping key, so **the same creator inscribing the same bytes
hits the same slot** and reverts `AlreadyInscribed(id)`. Different creators,
same bytes: different IDs, same `contentIdOf`. The ID is the same on every
chain and computable before inscribing: `glyphId(creator, content)`.
`verifyContent(id, content)` checks bytes against an ID; `isCreator(id, addr)`
recomputes the salted creator hash.

### Ownership word (`glyphs[id]`, one `uint256`)

```
bits 254..255   flags              (2)    bit 0 = EXISTS, bit 1 = BURNED
bits 225..253   transfer count     (29)   also the EIP-712 nonce; burn counts as a move
bits 194..224   owner-since block  (31)   block.number − DEPLOY_BLOCK, set on inscribe / transfer / burn
bits 163..193   created block      (31)   block.number − DEPLOY_BLOCK
bits 130..162   glyph number       (33)   sequential mint order, 1-based
bits   0..129   current owner ID   (130)  uint130(keccak256(owner ‖ glyphId)) | 1; 0 once burned
```

Widths are constants at the top of the contract with derived masks, so another
deployment can retune the slot without touching the ID format. Both block
fields are stored relative to the immutable `DEPLOY_BLOCK`; the getters
(`createdBlock`, `ownerSinceBlock`) return absolute block numbers.

### Stats (`stats`, one `uint256`)

```
bits  97..129   burn count             (33)
bits  33..96    total inscribed bytes  (64)
bits   0..32    glyph count            (33)
```

### Lifecycle

| Word                  | `exists` | `isBurned` | `isAlive` | `ownerOf`              | transfers / burn |
| --------------------- | -------- | ---------- | --------- | ---------------------- | ---------------- |
| `0` (never inscribed) | false    | false      | false     | reverts `NotInscribed` | `NotInscribed`   |
| `EXISTS`              | true     | false      | true      | 130-bit owner ID       | ok               |
| `EXISTS \| BURNED`    | true     | true       | false     | `0`                    | `Burned(id)`     |

`EXISTS` is never cleared (`isBurnt` is an alias of `isBurned`): a burned glyph keeps its number and created block,
`isOwner` is false for every address (including `0x0`), and the creator can
never re-inscribe those bytes. Burn is owner-only, no signed or operator burn,
and it is the only way to `0x0`: every transfer path rejects `to == 0x0` with
`ZeroRecipient()`.

---

## Signed writes

The signer signs EIP-712 typed data; anyone can submit it. `from` / `creator`
is passed explicitly because storage holds only salted hashes: the kernel
checks the hash against the slot, then checks the signature against the
address. `msg.sender` is the relayer or operator; the event still says
`from → to`.

**Domain:** `name = "Glyph Kernel"`, `version = "2"`, `chainId`,
`verifyingContract` — also served by ERC-5267 `eip712Domain()`.

| Method                                                           | Typed data                                                                             | Who submits                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `inscribeWithSig(creator, initialOwner, content, deadline, sig)` | `Inscribe(bytes32 contentId,address initialOwner,uint256 deadline)`                    | anyone; the signer becomes the creator                  |
| `transferWithSig(from, to, id, deadline, sig)`                   | `Transfer(uint256 glyphId,uint32 nonce,address to,uint256 deadline)`                   | anyone; `to` is fixed by the signature                  |
| `transferWithAuth(from, to, id, deadline, sig)`                  | `Authorize(uint256 glyphId,uint32 nonce,address operator,uint256 deadline)`            | only `operator` (`msg.sender`); the operator picks `to` |
| `transferWithSig(from, to, ids[], deadline, sig)`                | `BatchTransfer(uint256[] glyphIds,uint32[] nonces,address to,uint256 deadline)`        | anyone                                                  |
| `transferWithAuth(from, to, ids[], deadline, sig)`               | `BatchAuthorize(uint256[] glyphIds,uint32[] nonces,address operator,uint256 deadline)` | only `operator`                                         |

- `Inscribe.contentId` is the full `keccak256(content)`. There is no nonce:
  the content-keyed ID is the replay protection — a second submission reverts
  `AlreadyInscribed`, forever (burn does not free the ID).
- `nonce` is `transferCount(id)` **at signing time**. The kernel rebuilds the
  digest from the current count, so a signature is valid until the glyph moves
  (or the `deadline` passes). No nonce storage.
- **Cancel** = move the glyph to yourself: `transfer(me, id)` bumps the count
  and kills every outstanding signature for it.
- `deadline` is the last valid `block.timestamp`, inclusive.
- **Signers without code** are checked with OpenZeppelin `ECDSA`: 65-byte
  `(r, s, v)` or 64-byte EIP-2098 `(r, vs)`, high `s` rejected, so a
  signature has one valid form. **Signers with code** (smart wallets, EIP-7702
  delegated EOAs) are asked via ERC-1271 `isValidSignature` — unrestricted, the
  wallet sets its own rules.
- Batches are atomic and use standard EIP-712 array hashing
  (`keccak256(abi.encodePacked(ids))`, `keccak256(abi.encodePacked(nonces))`).
- Escrow-less marketplace: the seller signs `Authorize(id, nonce, marketplace,
deadline)`; on sale the marketplace calls `transferWithAuth(seller, buyer, id, …)`
  in the same tx that settles payment.

## No receiver hook

Like ERC-20, the kernel never calls the recipient. Any address can hold a
glyph; a contract moves it by calling `transfer` (or by signing). A contract
that cannot make that call keeps the glyph forever — check your recipient.
This keeps every transfer at one slot write and one event, with no
`EXTCODESIZE` or external call. `safeTransfer`-style opt-in overloads may be
added later; they would not change storage or IDs.

---

## Basic integration

### JS / TS (viem)

```ts
import {
  concatHex,
  keccak256,
  toHex,
  toBytes,
  decodeAbiParameters,
  parseAbi,
  parseEventLogs,
} from "viem";

const KERNEL = "0x…"; // deployed GlyphKernel

const abi = parseAbi([
  "function inscribe(address initialOwner, bytes content) returns (uint256 id, bytes32 contentId)",
  "function inscribe(address initialOwner, bytes[] contents) returns (uint256[] ids)",
  "function inscribe(address[] initialOwners, bytes[] contents) returns (uint256[] ids)",
  "function inscribeWithSig(address creator, address initialOwner, bytes content, uint256 deadline, bytes sig) returns (uint256 id, bytes32 contentId)",
  "function transfer(address to, uint256 id)",
  "function transfer(address to, uint256[] ids)",
  "function burn(uint256 id)",
  "function burn(uint256[] ids)",
  "function transferWithSig(address from, address to, uint256 id, uint256 deadline, bytes sig)",
  "function transferWithAuth(address from, address to, uint256 id, uint256 deadline, bytes sig)",
  "function transferWithSig(address from, address to, uint256[] ids, uint256 deadline, bytes sig)",
  "function transferWithAuth(address from, address to, uint256[] ids, uint256 deadline, bytes sig)",
  "function glyphId(address creator, bytes content) pure returns (uint256)",
  "function transferCount(uint256 id) view returns (uint32)",
  "event GlyphTransfer(uint256 indexed glyphId, address indexed from, address indexed to)",
]);

// ── Inscribe, raw (cheapest) ─────────────────────────────────────
const content = toHex(toBytes("hello, glyph")); // any bytes ≤ 24 200
const data = concatHex(["0x01", initialOwner, content]); // 0x01 ‖ initialOwner ‖ content

// The ID is known before sending: creator = the sender
const glyphId = await publicClient.readContract({
  address: KERNEL,
  abi,
  functionName: "glyphId",
  args: [sender, content],
});

const hash = await walletClient.sendTransaction({ to: KERNEL, data });
const receipt = await publicClient.waitForTransactionReceipt({ hash });

// The same ID comes back in the GlyphTransfer event (from = 0x0) and as the call's return data
const [log] = parseEventLogs({ abi, logs: receipt.logs, eventName: "GlyphTransfer" });
log.args.glyphId === glyphId; // true

// Or simulate first to get (glyphId, contentId) without waiting for the receipt:
const { data: ret } = await publicClient.call({ to: KERNEL, data, account: sender });
const [id, contentId] = decodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], ret!);

// ── Inscribe, ABI (same result) ──────────────────────────────────
await walletClient.writeContract({
  address: KERNEL,
  abi,
  functionName: "inscribe",
  args: [initialOwner, content],
});

// ── Batch inscribe, raw: 0x03 ‖ initialOwner ‖ (size(2) ‖ content)+ ──
const items = ["one", "two", "three"].map((s) => toHex(toBytes(s)));
const framed = items.map((c) => concatHex([toHex(toBytes(c).length, { size: 2 }), c]));
await walletClient.sendTransaction({
  to: KERNEL,
  data: concatHex(["0x03", initialOwner, ...framed]),
});
// return data = the new IDs, 32 bytes each

// ── Signed inscribe: creator signs, anyone relays ────────────────
const mintSig = await creatorClient.signTypedData({
  domain: { name: "Glyph Kernel", version: "2", chainId, verifyingContract: KERNEL },
  types: {
    Inscribe: [
      { name: "contentId", type: "bytes32" },
      { name: "initialOwner", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "Inscribe",
  message: { contentId: keccak256(content), initialOwner, deadline },
});
await relayer.writeContract({
  address: KERNEL,
  abi,
  functionName: "inscribeWithSig",
  args: [creator, initialOwner, content, deadline, mintSig],
});

// ── Transfer (batch), raw and ABI ────────────────────────────────
const ids = [glyphId, otherGlyphId];
const packedIds = ids.map((i) => toHex(i, { size: 32 }));
await walletClient.sendTransaction({
  to: KERNEL,
  data: concatHex(["0x02", recipient, ...packedIds]),
});
// or
await walletClient.writeContract({
  address: KERNEL,
  abi,
  functionName: "transfer",
  args: [recipient, ids],
});

// ── Burn, raw and ABI ────────────────────────────────────────────
await walletClient.sendTransaction({ to: KERNEL, data: concatHex(["0x04", ...packedIds]) });
await walletClient.writeContract({ address: KERNEL, abi, functionName: "burn", args: [glyphId] });

// ── Signed transfer: owner signs, anyone relays ──────────────────
const nonce = await publicClient.readContract({
  address: KERNEL,
  abi,
  functionName: "transferCount",
  args: [glyphId],
});
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
const sig = await walletClient.signTypedData({
  domain: { name: "Glyph Kernel", version: "2", chainId, verifyingContract: KERNEL },
  types: {
    Transfer: [
      { name: "glyphId", type: "uint256" },
      { name: "nonce", type: "uint32" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "Transfer",
  message: { glyphId, nonce, to: recipient, deadline },
});
// relayer:
await relayer.writeContract({
  address: KERNEL,
  abi,
  functionName: "transferWithSig",
  args: [owner, recipient, glyphId, deadline, sig],
});

// ── Read back the content ────────────────────────────────────────
const tx = await publicClient.getTransaction({ hash });
const bytes = toBytes(tx.input).slice(21); // strip 0x01 ‖ initialOwner
```

### Foundry `cast`

```sh
# inscribe "gm" to yourself — raw, or ABI
cast send $KERNEL $(cast concat-hex 0x01 $ME $(cast from-utf8 gm)) --private-key $PK
cast send $KERNEL "inscribe(address,bytes)" $ME $(cast from-utf8 gm) --private-key $PK

# the ID, before or after: creator ‖ content
cast call $KERNEL "glyphId(address,bytes)(uint256)" $ME $(cast from-utf8 gm)

# transfer two glyphs to $BOB (each ID is a full 32-byte word)
cast send $KERNEL $(cast concat-hex 0x02 $BOB $(cast to-uint256 $ID1) $(cast to-uint256 $ID2)) --private-key $PK
cast send $KERNEL "transfer(address,uint256[])" $BOB "[$ID1,$ID2]" --private-key $PK

# burn
cast send $KERNEL $(cast concat-hex 0x04 $(cast to-uint256 $ID1)) --private-key $PK
cast send $KERNEL "burn(uint256)" $ID1 --private-key $PK

# reads
cast call $KERNEL "glyphCount()(uint256)"
cast call $KERNEL "ownerOf(uint256)(uint256)" $ID
cast call $KERNEL "isOwner(uint256,address)(bool)" $ID $ME
cast call $KERNEL "isAlive(uint256)(bool)" $ID
cast call $KERNEL "transferCount(uint256)(uint32)" $ID      # = EIP-712 nonce
```

### From another contract

```solidity
interface IGlyphKernel {
    function inscribe(address initialOwner, bytes calldata content) external returns (uint256 id, bytes32 contentId);
    function inscribe(address initialOwner, bytes[] calldata contents) external returns (uint256[] memory ids);
    function transfer(address to, uint256 id) external;
    function burn(uint256 id) external;
    function transferWithAuth(address from, address to, uint256 id, uint256 deadline, bytes calldata sig) external;
    function glyphId(address creator, bytes calldata content) external pure returns (uint256);
    function exists(uint256 id) external view returns (bool);
    function isAlive(uint256 id) external view returns (bool);
    function ownerOf(uint256 id) external view returns (uint256);
    function creatorOf(uint256 id) external pure returns (uint256);
    function isOwner(uint256 id, address account) external view returns (bool);
    function isCreator(uint256 id, address account) external pure returns (bool);
    function verifyContent(uint256 id, bytes calldata content) external pure returns (bool);
    function transferCount(uint256 id) external view returns (uint32);
    function ownerSinceBlock(uint256 id) external view returns (uint256);
}

contract GlyphGate {
    IGlyphKernel immutable kernel;
    constructor(IGlyphKernel k) { kernel = k; }

    modifier onlyHolder(uint256 id) {
        require(kernel.isOwner(id, msg.sender), "not the holder");
        _;
    }

    // mint straight to the caller: the owner is a parameter, this contract is the creator
    function inscribeFor(bytes calldata content) external returns (uint256 id, bytes32 contentId) {
        return kernel.inscribe(msg.sender, content);
    }

    // escrow-less sale: seller signed Authorize(id, nonce, address(this), deadline)
    function buy(address seller, uint256 id, uint256 deadline, bytes calldata sig) external payable {
        // ...take payment...
        kernel.transferWithAuth(seller, msg.sender, id, deadline, sig);
    }
}
```

> Note: when a contract inscribes, `msg.sender` for the kernel is that contract —
> so **the contract is the creator** (the ID is derived from its address) — but
> the **initial owner is whatever address you pass**, so you can mint straight
> to the end user. Plain transfers must be sent by the current owner
> (`msg.sender` is checked), so a contract can only move glyphs _it_ owns — or
> glyphs whose owner signed a `Transfer` / `Authorize` for it.

---

## Provenance

| Question                            | On-chain (needs candidate address) | On-chain (IDs only)            | Off-chain                                                 |
| ----------------------------------- | ---------------------------------- | ------------------------------ | --------------------------------------------------------- |
| Who **created** it?                 | `isCreator(id, addr)`              | `creatorOf(id)` → 100-bit ID   | `GlyphTransfer` with `from = 0x0`: the tx sender / signer |
| Who **owns** it now?                | `isOwner(id, addr)`                | `ownerOf(id)` → 130-bit ID     | last `GlyphTransfer.to`                                   |
| Is it **alive**?                    | —                                  | `isAlive(id)` / `isBurned(id)` | last `GlyphTransfer.to != 0x0`                            |
| **When** was it created?            | —                                  | `createdBlock(id)`             | block of the mint log                                     |
| Mint **order**?                     | —                                  | `glyphNumber(id)`              | count mint logs                                           |
| **How long** has the owner held it? | —                                  | `ownerSinceBlock(id)`          | block of the last `GlyphTransfer`                         |
| **How many** hands?                 | —                                  | `transferCount(id)`            | count `GlyphTransfer` logs (minus the mint)               |
| **What** is it?                     | `verifyContent(id, bytes)`         | `contentIdOf(id)`              | calldata of the inscribing tx                             |

### Verifying a claim ("I own glyph X")

```ts
// 1. prove the glyph is alive and the claimant holds it — one eth_call each
await kernel.read.isAlive([id]); // true
await kernel.read.isOwner([id, claimant]); // true

// 2. (optional) prove they're also the original creator
await kernel.read.isCreator([id, claimant]);

// 3. (optional) verify the content they show you is the real thing
await kernel.read.verifyContent([id, content]); // or keccak256(content) low 156 bits == contentIdOf(id)
```

Because owner and creator IDs are salted hashes, a wallet can prove ownership
with nothing more than its address — no signature needed for reads — and
nobody can enumerate owners from storage alone, nor grind one preimage against
many glyphs. Indexers reconstruct the address graph from `GlyphTransfer`, which
always carries full addresses.

### Walking the chain of custody

```
GlyphTransfer(id, 0x0 → A)   ← block N     creatorOf(id) == H100(A ‖ contentId), ownerOf(id) == H130(A ‖ id)
GlyphTransfer(id, A → B)     ← block N+k   ownerOf(id) == H130(B ‖ id), transferCount(id) == 1
GlyphTransfer(id, B → C)     ← block N+m   ownerOf(id) == H130(C ‖ id), transferCount(id) == 2
GlyphTransfer(id, C → 0x0)   ← block N+p   ownerOf(id) == 0, isBurned(id), transferCount(id) == 3
```

Storage remembers only the current owner; the full history is the event log.
`isCreator` is pure — it's decoded from the ID — so creator provenance
survives even if you only have the ID and nothing else.

---

## Reference: external API

### Writes

| Function                                                                                                                                 | Raw twin | Notes                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------- |
| `inscribe(address initialOwner, bytes content)` → `(uint256 id, bytes32 contentId)`                                                      | `0x01`   | creator = `msg.sender`                                |
| `inscribe(address initialOwner, bytes[] contents)` → `uint256[] ids`                                                                     | `0x03`   | one owner                                             |
| `inscribe(address[] initialOwners, bytes[] contents)` → `uint256[] ids`                                                                  | —        | airdrop / mint-to-many; the airdropper is the creator |
| `inscribeWithSig(address creator, address initialOwner, bytes content, uint256 deadline, bytes sig)` → `(uint256 id, bytes32 contentId)` | —        | `Inscribe` typed data; the signer is the creator      |
| `transfer(address to, uint256 id)`                                                                                                       | —        | from `msg.sender`; self-transfer = cancel signatures  |
| `transfer(address to, uint256[] ids)`                                                                                                    | `0x02`   | from `msg.sender`                                     |
| `burn(uint256 id)`                                                                                                                       | —        | owner only                                            |
| `burn(uint256[] ids)`                                                                                                                    | `0x04`   | owner only                                            |
| `transferWithSig(address from, address to, uint256 id, uint256 deadline, bytes sig)`                                                     | —        | `Transfer` typed data                                 |
| `transferWithAuth(address from, address to, uint256 id, uint256 deadline, bytes sig)`                                                    | —        | `Authorize` typed data, `msg.sender` = operator       |
| `transferWithSig(address from, address to, uint256[] ids, uint256 deadline, bytes sig)`                                                  | —        | `BatchTransfer`                                       |
| `transferWithAuth(address from, address to, uint256[] ids, uint256 deadline, bytes sig)`                                                 | —        | `BatchAuthorize`                                      |

All batches require at least one item and are atomic.

### Reads

| Function                                                      | Kind  | Returns                                                     |
| ------------------------------------------------------------- | ----- | ----------------------------------------------------------- |
| `MAX_CONTENT_SIZE`                                            | const | `24_200`                                                    |
| `DEPLOY_BLOCK`                                                | immut | block the kernel was deployed in                            |
| `stats`                                                       | view  | raw packed counters                                         |
| `glyphs(uint256)`                                             | view  | raw packed ownership word                                   |
| `glyphCount()` / `burnCount()` / `totalInscribedSize()`       | view  | `uint256`                                                   |
| `glyphId(address creator, bytes content)`                     | pure  | `uint256`                                                   |
| `creatorOf(id)` / `contentIdOf(id)`                           | pure  | 100-bit creator ID / 156-bit content ID                     |
| `isCreator(id, address)` / `isCreator(id, uint256)`           | pure  | `bool`                                                      |
| `verifyContent(id, bytes content)`                            | pure  | `bool`                                                      |
| `exists(id)` / `isBurned(id)` / `isBurnt(id)` / `isAlive(id)` | view  | `bool`                                                      |
| `isAlive(uint256[] ids)`                                      | view  | `bool[]`                                                    |
| `glyphNumber(id)`                                             | view  | `uint256`, 0 for unknown                                    |
| `createdBlock(id)` / `ownerSinceBlock(id)`                    | view  | absolute block number, 0 for unknown                        |
| `transferCount(id)`                                           | view  | `uint32`                                                    |
| `ownerOf(id)`                                                 | view  | 130-bit owner ID · `0` once burned · reverts `NotInscribed` |
| `isOwner(id, address)` / `isOwner(id, uint256)`               | view  | `bool`                                                      |
| `eip712Domain()`                                              | view  | ERC-5267 domain fields                                      |

**Errors:** `AlreadyInscribed(id)`, `Burned(id)`, `ContentTooLarge(size)`,
`CountOverflow()`, `InvalidCalldata()`, `InvalidSignature()`,
`NotInscribed(id)`, `SignatureExpired()`, `TransferCountOverflow(id)`,
`Unauthorized()`, `UnknownOperation(op)`, `ZeroOwner()`,
`ZeroRecipient()`.

**Event:** `GlyphTransfer(uint256 indexed glyphId, address indexed from, address indexed to)`
— mint `from = 0x0`, burn `to = 0x0`, no data word.

---

## Security model

- **The 130-bit salted owner ID is the only field that authorizes value.**
  Forging ownership means finding an address whose `keccak256(addr ‖ glyphId)`
  matches one specific glyph's stored ID — the salt makes every glyph its own
  target, so no any-of-N shortcut exists.
- **The 100-bit salted creator ID is sound for on-chain provenance**; the
  156-bit content ID is collision-safe (2^78 work), and only the creator could
  attack their own glyph.
- **Fields that wrap** — the two 31-bit block fields (~2^31 blocks, about 400
  years at 6 s slots before they wrap relative to `DEPLOY_BLOCK`) — only degrade
  age math in other contracts; consumers subtract modulo 2^31. `glyphNumber`
  is the absolute mint order.
- **`transferCount` and `number` never wrap**; they revert at max
  (`TransferCountOverflow`, `CountOverflow`).
- **Signatures** are non-malleable ECDSA (OpenZeppelin) or ERC-1271, bound to chain and contract
  by EIP-712, replay-protected by the per-glyph transfer count (transfers) or
  the content-keyed ID (inscribe), and time-boxed by `deadline`.
- **No external calls** on any write path except the ERC-1271 `staticcall`
  to a signer with code; there is nothing to re-enter through.

## Caveats

- Owner / creator IDs are truncated hashes (130 / 100 bits) — collision-resistant
  for any practical purpose, but they are **commitments, not addresses**. Use
  events to get addresses.
- The same content under different creators yields different glyphs with the
  same `contentIdOf`. Under the same creator it is one glyph, forever.
- Signatures are not unique identifiers (ECDSA is malleable for 1271 wallets
  that allow it); their replay protection is the nonce / the ID, not the bytes.
  A transfer signature stays valid until the glyph moves or the deadline
  passes — sign with a deadline you mean.
- Not ERC-721: no `approve` / `safeTransferFrom` / `tokenURI` / receiver
  hook. Wrap it if you need marketplace compatibility;
  `transferWithAuth` covers the escrow-less case.
- Raw payloads are dispatched on the first byte; no ABI selector of the kernel
  starts with `0x01..0x04`, and the `selectors` script enforces that.
- Sending plain ETH reverts (no `receive`).

## Build & Testing

Project is managed by Pnpm, VitePlus, and Foundry.

From the root of the monorepo:

```
# solidity tool chain: fmt/lint/test/build/checks
vp run solidity:check

# run only glyph protocol
vp run --filter glyph-protocol fmt
vp run --filter glyph-protocol lint
vp run --filter glyph-protocol test
vp run --filter glyph-protocol build

# or just `check` it runs everything needed
vp run --filter glyph-protocol check
```

from this project's folder

```
vp run fmt
vp run lint
vp run test
vp run build

# or just
vp run check
```

## License

Apache-2.0
