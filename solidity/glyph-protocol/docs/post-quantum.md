# Quantum attacks and the post-quantum path

What a quantum adversary changes for the kernel, and why the protocol survives Ethereum's signature migration without changes. Short version: the hashes are not the weak point, ECDSA is, and that is an Ethereum-wide problem the kernel inherits and outlives.

## The three quantum tools

- Shor's algorithm breaks secp256k1. A large fault-tolerant quantum computer recovers the private key from any exposed public key. Every EOA that ever sent a transaction has exposed its key. This is the real threat, it hits all of Ethereum at once, and against it the attacker does not forge anything in the kernel — they simply become the owner.
- Grover's algorithm halves preimage exponents. An n-bit hash preimage costs about 2^(n/2) quantum evaluations instead of 2^n. Grover parallelizes badly (k machines give only a √k speedup) and each iteration is a full keccak circuit on error-corrected hardware, orders of magnitude slower per evaluation than a classical ASIC.
- Quantum collision search reaches about 2^(n/3) but needs comparable quantum memory; classical parallel collision finding is considered cheaper in practice.

## What that does to the kernel's fields

| field                     | bits    | classical preimage | quantum (Grover) |
| ------------------------- | ------- | ------------------ | ---------------- |
| current owner ID (salted) | 130     | 2^130              | 2^65             |
| creator ID (salted)       | 96–100  | 2^96+              | 2^48+            |
| content ID                | 132–156 | 2^132+             | 2^66+            |

Every quantum number above is a multi-year computation on machines that do not exist, spent on forging provenance or ownership of one glyph — and those machines arrive after the Shor machines that already break the accounts themselves. The field widths do not move the quantum picture; the signature scheme does.

## Why the protocol survives the signature migration

The kernel anchors identity to addresses, and addresses are what Ethereum keeps across a post-quantum migration. Every serious migration path keeps the account identifier and swaps the authorization behind it: new protocol-level signature types for existing accounts, or accounts becoming (or delegating to, via EIP-7702) contract accounts whose validation code is replaceable. The address stays; only "how do you prove you are it" changes.

The kernel has three authorization paths, and each maps cleanly onto that future:

- The `msg.sender` paths — `transfer`, `burn`, plain `inscribe` — never see a signature. Whatever Ethereum accepts as valid authorization for an account to make a call, the kernel inherits for free. This is most of the protocol.
- The ERC-1271 path survives untouched. A smart account swaps its internal validation to a post-quantum scheme, keeps its address, and `isValidSignature` keeps answering. The kernel never sees the scheme. Every signed method — `inscribeWithSig`, `transferWithSig`, `transferWithAuth` — already takes this path for any signer with code.
- The raw ECDSA path (signed methods used by EOAs) dies exactly when ECDSA dies for everything else on Ethereum. Its users move to the 1271 path by becoming smart accounts at the same address.

State needs no migration either: the kernel stores salted hashes of addresses, so there is no "map old identity to new identity" event. An owner who wants a fresh post-quantum-clean address does one ordinary transfer.

## Smart accounts are scheme-agnostic, not quantum-safe

A contract account has no private key for Shor to attack; its security equals whatever its validation code checks. Today that is almost always still an ECDSA key behind an ERC-1271 wrapper, which Shor breaks identically. The reason account abstraction is the migration path is upgradability, not present safety: the account swaps its verifier module to a post-quantum scheme without changing address, without moving assets, without touching protocols like this one. EOAs cannot make that swap without a protocol fork.

One wrinkle in the kernel's favor: state holds only salted hashes, so owning a glyph reveals nothing about the owner's key until they sign. A glyph on a fresh address that never transacted gives Shor nothing to eat. That protection ends the moment the owner transfers, the same as ETH on a fresh address.

## The residual risk

Glyphs sitting on dormant EOAs whose public keys are already exposed get taken by whoever runs the first large Shor machine, exactly like the ETH on those accounts. No application layer can prevent that; the fix is Ethereum's post-quantum migration and users moving to accounts with replaceable validation.
