# 0xNeko PFP — Project & Game Mechanics

Fully on-chain, pixel-perfect generative cat PFPs. Every image is an SVG rendered entirely by contract code — no IPFS, no servers. Fixed supply of **4663** cats minted through SeaDrop, revealed all at once via a committed deterministic seed, then played with forever through a burn-based fusion game: merge duplicates, mutate any two cats, and grow provably scarce high-mass cats.

## The collection

Each cat is assembled from colored parts: **sky** (background), **head**, **face**, **two eyes**, **mouth**, **body**, **tail**, **four legs**, and a **toy** (one of 37 emoji companions — mouse, blowfish, pretzel, rubberduck, …). Base parts draw from a 20-color palette (16 chromatic hues plus black, white, gray, slate); face parts from a 13-color contrast-checked subset. Color selection enforces minimum hue contrast between adjacent parts, so every cat is legible against its sky.

Two rare generation classes exist:

- **Matrix** (~3%): the sky is replaced by a static code-rain background. Matrix cats never spawn with a black body (they'd vanish into the rain).
- **Invisible** (~1%): the cat's body parts all take the sky color — only the face floats against the background.

**Guaranteed quotas:** exactly **96 visible black cats** and **96 visible white cats** exist in the collection. This is not probabilistic — a keyed 13-bit Feistel permutation over token positions deterministically assigns which 192 token IDs get the quota classes, and per-token rejection sampling guarantees the drawn seed actually produces that class.

## Committed deterministic reveal

The collection seed is committed (as a domain-separated hash) at deploy time, **before any mint**. After the full 4663 supply is minted, the owner reveals the preimage; the contract verifies it against the commitment and unlocks metadata for every token simultaneously.

- Until reveal, every token shows the same placeholder cat and merging/mutating is disabled.
- After reveal, each token's traits derive purely from `(genesisSeed, tokenId)` — anyone can verify the entire corpus offline with `deriveTokenSeed`, and nobody (miner, minter, or contract owner post-commit) could have altered the outcome.
- The trade-off is transparency, not trust: the deployer necessarily knows the seed in advance, which is why the commitment (and corpus) is published up front.

## Fusion: the burn game

Every cat starts with **fusion mass 1**. The only way mass grows — and the only way supply shrinks — is by burning one cat into another. Both actions require the caller to be owner or approved for **both** tokens, and both permanently destroy the consumed token.

### Merge (duplicates)

Two cats with an **identical visual signature** — same matrix flag, sky, head, face, body, tail, legs, eyes, and mouth (the toy is ignored) — can be merged. The consumed cat burns; the survivor absorbs its fusion mass. Merging is the fate of duplicates: the generator can and will produce visually identical cats, and the game turns those collisions into fuel.

### Mutate (any two different cats)

Two cats with **different** signatures can be fused with surgical control. The caller picks any subset of the consumed cat's 13 parts via a bitmask, and those parts are grafted onto the survivor:

| bit             | part                                          |
| --------------- | --------------------------------------------- |
| 0x0001          | sky (carries matrix/invisible nature with it) |
| 0x0002          | head                                          |
| 0x0004          | face                                          |
| 0x0008          | body                                          |
| 0x0010          | tail                                          |
| 0x0020–0x0100   | legs 1–4 (individually)                       |
| 0x0200 / 0x0400 | left / right eye                              |
| 0x0800          | mouth                                         |
| 0x1000          | toy                                           |

The consumed cat burns; masses combine; the survivor permanently wears its new grafted traits (stored on-chain, overriding its seed-derived look). A mutation that wouldn't visibly change the survivor reverts — every mutation must matter.

**Emergent plays this enables:**

- **Craft duplicates**: mutate a cat until its signature matches another cat you hold, then merge them. Duplicates are no longer just found — they're manufactured.
- **Craft invisibles**: graft parts until every body part matches the sky and the cat becomes Invisible — the 1% class, now earnable at the cost of burned cats.
- **Steal the Matrix**: the code-rain background transfers with the sky bit.
- **Toy trading**: toys ride along on bit 0x1000 without affecting merge compatibility.

### Mass and scarcity

- **Fusion mass** is conserved: the sum of all living cats' masses always equals the number of cats ever minted. The theoretical ceiling is one cat of mass 4663.
- Cats with mass above 1 display a **star badge** in their art.
- **Slop Tier** (0–5) counts a cat's "alternate" parts — head, eye(s), mouth, leg(s), or tail differing from its base color — and updates as mutations change the cat.

### Ancestry

Every fusion writes a permanent on-chain family-tree node recording both parents' lineages, the action taken (merge vs. mutation), and the mutation mask. Each living cat points at the root of its tree; burned ancestors' lineage records are never erased. A high-mass cat isn't just a number — its entire construction history is queryable forever.

### Burning, summarized

- Burning happens **only** through merge and mutate — there is no plain burn and no way to un-burn.
- Supply is fixed at mint (4663 hard cap, enforced independently of SeaDrop config) and strictly deflationary afterward.
- A consumed cat's mutable state (mass, mutation traits, counters) is wiped at burn; only its ancestry contribution survives.
- The game's core tension: every rarer, heavier, more customized cat costs the permanent destruction of another.
