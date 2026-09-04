# Signing Key Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support safe ES256 signing-key rotation by signing with one active key while publishing exactly one or two retained public keys.

**Architecture:** Replace the single private JWK binding with one atomic `SIGNING_KEYRING` JSON object containing `active_kid` and one or two private JWKs. Promotion changes only `active_kid`; the two retained keys represent current+next before promotion and previous+current during token grace.

**Tech Stack:** TypeScript 6, JOSE, Cloudflare Workers, Vitest through Vite+

## Global Constraints

- ID-token lifetime remains exactly five minutes.
- Every signing key must be EC P-256, private, ES256-compatible, and have a unique nonempty `kid`.
- JWKS publishes no private or unallowlisted JWK fields and never more than two keys.
- Do not touch `vite.config.ts`.
- Run `vp run check` and `vp run build`.

---

### Task 1: Atomic Signing Keyring

**Files:**

- Modify: `src/types.ts`
- Modify: `src/tokens.ts`
- Modify: `src/routes/oauth.ts`
- Test: `test/tokens.test.ts`
- Test: `test/oauth.test.ts`

**Interfaces:**

- Consumes: `SIGNING_KEYRING` JSON shaped as `{ "active_kid": string, "keys": JsonWebKey[] }`.
- Produces: `issueIdToken(...)` signing only with `active_kid`; `publicJwks(env): Promise<Record<string, unknown>[]>` returning one or two public JWKs.

- [ ] **Step 1: Write failing keyring tests**

Cover signing with the second retained key, publishing both public keys, rejected duplicate/missing `kid`, absent active key, more than two keys, invalid private keys, and private-field stripping.

- [ ] **Step 2: Verify tests fail**

Run: `vp test test/tokens.test.ts test/oauth.test.ts`

Expected: failures because only `SIGNING_PRIVATE_JWK` and `publicJwk` exist.

- [ ] **Step 3: Implement one canonical parser**

Parse and validate the entire keyring once per operation in `src/tokens.ts`. Import each private JWK with JOSE, enforce unique IDs and one-to-two keys, select `active_kid` for signing, and map all retained keys through a strict public-field allowlist.

- [ ] **Step 4: Publish the key collection**

Change `/.well-known/jwks.json` to return `{ keys: await publicJwks(c.env) }`.

- [ ] **Step 5: Verify token tests pass**

Run: `vp test test/tokens.test.ts test/oauth.test.ts test/demo-protocol.test.ts`

Expected: all focused tests pass and the existing verifier can select either `kid`.

### Task 2: Rotation Operations

**Files:**

- Modify: `scripts/check-config.mjs`
- Modify: `scripts/generate-key.mjs`
- Modify: `.dev.vars.example`
- Modify: `wrangler.toml`
- Modify: `README.md`
- Test: `test/config.test.ts`

**Interfaces:**

- Produces: configuration validation and the documented current/next, previous/current rotation sequence.

- [ ] **Step 1: Add failing config tests**

Test valid one- and two-key keyrings plus malformed JSON, duplicate IDs, missing active ID, inactive active ID, invalid key shape, and a third key.

- [ ] **Step 2: Verify config tests fail**

Run: `vp test test/config.test.ts`

Expected: failures because the checker still expects one JWK.

- [ ] **Step 3: Update operational tooling**

Make `vp run keygen` continue emitting one private JWK suitable for insertion into the keyring. Update the checker to validate the same invariants as runtime. Document: publish current+next, wait for propagation, promote next, retain previous for token lifetime plus skew/cache allowance, then remove previous and generate a new next.

- [ ] **Step 4: Verify and commit**

Run: `vp test test/tokens.test.ts test/oauth.test.ts test/demo-protocol.test.ts test/config.test.ts`

Expected: all focused tests pass.

Commit: `feat: add signing key rotation`
