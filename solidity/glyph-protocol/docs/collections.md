# Collections on the Glyph Kernel

A collection is not a kernel concept. A collection is a **creator**. Every glyph ID carries a salted hash of its creator, so "is glyph `id` part of collection `C`" is `kernel.isCreator(id, C)` — pure, free, forever, no registry. Launching a collection means deciding two things:

1. **Who the creator address is** — the artist's wallet, or a contract.
2. **How the pieces get inscribed** — who sends the bytes, who pays, what rules apply.

Three ways to do it, cheapest first.

---

## 1. The creator is the collection — no contract, `inscribeWithSig`

The creator's wallet is the collection. The creator signs one `Inscribe` per piece (off-chain, at checkout / claim time); the buyer relays and pays the gas.

- Creator = signer. Membership = `isCreator(id, creatorAddr)`.
- Replay protection is the content-keyed ID: the same bytes under the same creator revert `AlreadyInscribed`, so a piece can't be sold twice.
- Free mints. The kernel takes no value here.

```ts
// creator backend, per piece
const sig = await creatorWallet.signTypedData({
  domain: { name: "Glyph Kernel", version: "2", chainId, verifyingContract: KERNEL },
  types: {
    Inscribe: [
      { name: "contentId", type: "bytes32" },
      { name: "initialOwner", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "Inscribe",
  message: { contentId: keccak256(content), initialOwner: buyer, deadline },
});

// buyer (or any relayer): buyer owns it, creator is the creator
await kernel.write.inscribeWithSig([creatorAddr, buyer, content, deadline, sig]);

// anyone, later
await kernel.read.isCreator([id, creatorAddr]); // true ⇔ member
```

> [!NOTE]
> Creator could also airdrop to people: raw `0x03` batch or `inscribe(address[] owners, bytes[] contents)`. Same creator, same membership test.

---

## 2. Paid drops with `collectionMint` — creator-signed config

The creator signs **one config** (price, optional content root, deadline, salt). Every minter passes that config to the kernel; the kernel verifies the signature, the price and (optionally) the content, inscribes with the signer as creator, and forwards the payment to the creator in the same tx. The kernel never holds ETH.

The signer can be an EOA (wallet = collection, no contract) or a contract (ERC-1271: the contract is the collection and can apply its own rules — see 3).

### 2a. With Merkle root — fixed set of pieces, EOA creator, no contract

There could be `contentRoot` which is Merkle root of `keccak256(content)` for every piece. Supply = number of leaves (each leaf mints once, `AlreadyInscribed` rejects repeats). Buyers send the bytes.

```ts
const root = merkleRoot(artPieces.map((p) => keccak256(p.bytes)));
const cfg = {
  contentRoot: root,
  price: parseEther("0.02"),
  deadline,
  salt: keccak256("squares-drop"),
};

const sig = await creatorEOAWallet.signTypedData({
  domain: { name: "Glyph Kernel", version: "2", chainId, verifyingContract: KERNEL },
  types: {
    CollectionMint: [
      { name: "contentRoot", type: "bytes32" },
      { name: "price", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
  },
  primaryType: "CollectionMint",
  message: cfg,
});
```

Creator shows `{ cfg, sig, pieces, proofs }` and each buyer calls the kernel:

```ts
await kernel.write.collectionMint([creatorEOAWallet, cfg, sig, buyer, piece.bytes, piece.proof], {
  value: cfg.price,
});
// ETH lands in the creator's wallet in the same tx;
// creator = creatorEOAWallet; supply = leaves.
```

### 2b. Without Merkle root — open content, generative / seed-based

The merkle root would be `contentRoot = 0`, and any content bytes is accepted, usually a seed of sorts. The minter inscribes a small **seed** (anything unique per minter, e.g. `keccak256(minter ‖ nonce)`), the art is a pure function of the resulting glyph ID, served by the collection's `contentOf(id)` (see 3). No generation gas at mint, no content event, and the art is readable on-chain.

The minter side:

```ts
// the collection publishes its own config
const cfg = await squares.read.config();
const seed = keccak256(encodePacked(["address", "uint256"], [me, nonce]));

// known before sending
const id = await kernel.read.glyphId([squaresAddr, seed]);

await kernel.write.collectionMint([squaresAddr, cfg, "0x", me, seed, []], { value: cfg.price });

const svg = await kernel.read.contentOf([id, squaresAddr]);
// or squares.read.contentOf([id])
```

---

## 3. A generative collection contract (the contract is the creator)

The contract is the ERC-1271 signer of its own config, so it is the creator of every piece. It enforces price and supply, keeps its own money, and renders the art from the glyph ID. Set `CONTENT_ROOT` to `0` for open seeds, or to a Merkle root to restrict seeds / pieces — the kernel verifies the proof either way.

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

interface IGlyphKernel {
    struct MintConfig {
        bytes32 contentRoot;
        uint256 price;
        uint256 deadline;
        bytes32 salt;
    }

    function eip712Domain()
        external
        view
        returns (
            bytes1,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32,
            uint256[] memory
        );
}

/// @title Squares — on-chain generative drop on the Glyph Kernel.
/// @notice This contract is the creator of every Squares glyph. Minters call
///         `kernel.collectionMint{value: PRICE}(address(squares), config(), "", to, seed, proof)`.
///         The content is a seed chosen by the minter; the art is a pure function of the
///         resulting glyph ID, served by `contentOf`. The `CONTENT_ROOT == 0` accepts any seed;
///         a non-zero root restricts seeds to a committed set (the kernel checks the proof).
contract Squares {
    uint256 public constant PRICE = 0.01 ether;
    uint256 public constant MAX_SUPPLY = 1_000;
    bytes32 public constant SALT = keccak256("squares-v1");

    address public immutable KERNEL;
    address public immutable ARTIST;
    uint256 public immutable DEADLINE;
    bytes32 public immutable CONTENT_ROOT;
    bytes32 private immutable CONFIG_DIGEST; // EIP-712 digest of config() under the kernel's domain

    uint256 public supply;

    error NotKernel();
    error SoldOut();
    error NotArtist();
    error WithdrawFailed();

    constructor(address kernel, address artist, uint256 deadline, bytes32 contentRoot) {
        KERNEL = kernel;
        ARTIST = artist;
        DEADLINE = deadline;
        CONTENT_ROOT = contentRoot;

        (, string memory name, string memory version, uint256 chainId, address verifying,,) =
            IGlyphKernel(kernel).eip712Domain();

        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifying
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("CollectionMint(bytes32 contentRoot,uint256 price,uint256 deadline,bytes32 salt)"),
                contentRoot,
                PRICE,
                deadline,
                SALT
            )
        );
        CONFIG_DIGEST = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    /// @notice The config minters pass to `kernel.collectionMint`.
    function config() external view returns (IGlyphKernel.MintConfig memory) {
        return IGlyphKernel.MintConfig(CONTENT_ROOT, PRICE, DEADLINE, SALT);
    }

    /// @notice ERC-1271: the kernel asks "did you sign this config?". Yes iff it is exactly
    ///         ours and we are not sold out. Further view rules (allowlist, phase) go here.
    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        if (digest != CONFIG_DIGEST || supply >= MAX_SUPPLY) {
            return 0xffffffff;
        }

        return 0x1626ba7e;
    }

    /// @notice The kernel forwards the mint price here after inscribing. Counting happens
    ///         here because this is a real call (state allowed); reverting undoes the mint.
    receive() external payable {
        if (msg.sender != KERNEL) {
            revert NotKernel();
        }
        if (++supply > MAX_SUPPLY) {
            revert SoldOut();
        }
    }

    function withdraw() external {
        if (msg.sender != ARTIST) {
            revert NotArtist();
        }

        (bool ok,) = ARTIST.call{value: address(this).balance}("");
        if (!ok) {
            revert WithdrawFailed();
        }
    }

    /// @notice The art. Pure function of the glyph ID (which the kernel derives from this
    ///         address + the minter's seed), so nothing is stored per glyph.
    function contentOf(uint256 glyphId) external pure returns (bytes memory) {
        uint256 hue = glyphId % 360;
        uint256 n = 3 + (glyphId >> 200) % 9;

        bytes memory body;
        for (uint256 i = 0; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(glyphId, i)));
            body = abi.encodePacked(
                body,
                '<rect x="',
                _u(r % 80),
                '" y="',
                _u((r >> 8) % 80),
                '" width="',
                _u(10 + (r >> 16) % 20),
                '" height="',
                _u(10 + (r >> 24) % 20),
                '" fill="hsl(',
                _u((hue + i * 37) % 360),
                ',70%,50%)"/>'
            );
        }

        return abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">', body, "</svg>"
        );
    }

    function _u(uint256 v) internal pure returns (bytes memory b) {
        if (v == 0) {
            return "0";
        }
        while (v != 0) {
            b = abi.encodePacked(bytes1(uint8(48 + v % 10)), b);
            v /= 10;
        }
    }
}
```

Gating on a collection from any contract:

```solidity
error NotHolder();
error NotYet();

modifier onlyHolderOf(address collection, uint256 id) {
    if (!kernel.isCreator(id, collection) || !kernel.isOwner(id, msg.sender)) {
        revert NotHolder();
    }
    _;
}

// a phase that opens once the protocol reaches glyph #N
if (kernel.glyphCount() <= 1000) {
    revert NotYet();
}
```

---

## Notes

- **Content.** In variants 1 and 2a the bytes are in the buyer's transaction calldata. In 2b and 3 the calldata holds the seed and the art comes from `contentOf(id)`. In all cases `keccak256(content) == contentIdOf(id)`.
- **Supply.** With a Merkle root, the supply is the number of leaves. With open seeds, count in the collection's `receive()` (paid mints) or check a limit in `isValidSignature`.
- **Payment.** One price per config. For another price, sign another config with a different `salt`. The kernel forwards the payment and never holds it. Free mints make no call.
- **Stopping a drop.** A config is valid until its `deadline`. A contract collection can stop earlier with a flag checked in `isValidSignature`. A wallet creator waits for the deadline.
- **Gas.** A `collectionMint` costs the same as normal inscribe, plus: signature check ~3.5k (EOA) or ~3k staticcall (ERC-1271), Merkle Proof ~100 per proof depth, and payment transfer 7k.
