# Secret Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give identifier derivation, claims encryption, rate limiting, and token signing independent secret bindings without changing stable identifiers or stranding in-flight encrypted claims.

**Architecture:** Replace `PAIRWISE_SECRET` with `IDENTIFIER_SECRET`, `RATE_LIMIT_SECRET`, and a serialized `CLAIMS_ENCRYPTION_KEYRING`. New claims use a key-ID-bearing `v2` envelope; the keyring may temporarily carry the old `PAIRWISE_SECRET` as `legacy` to decrypt existing `v1` rows during rollout.

**Tech Stack:** TypeScript 6, Cloudflare Workers, Web Crypto, Vitest through Vite+

## Global Constraints

- Do not change identifier derivation inputs or output formats.
- Initially set production `IDENTIFIER_SECRET` to the exact current `PAIRWISE_SECRET` value.
- Keep legacy claims decryption only as an explicit keyring rollout field.
- Do not touch `vite.config.ts`.
- Run `vp run check` and `vp run build`.

---

### Task 1: Versioned Claims Keyring

**Files:**

- Modify: `src/crypto.ts`
- Test: `test/claims.test.ts`

**Interfaces:**

- Consumes: `CLAIMS_ENCRYPTION_KEYRING` JSON with `{ "active": string, "keys": Record<string, string>, "legacy"?: string }`.
- Produces: unchanged `sealClaims(keyringJson, context, claims)` and `openClaims(keyringJson, context, sealed)` signatures; new envelopes use `v2.<key-id>.<payload>`.

- [ ] **Step 1: Write failing tests**

Add tests proving that `sealClaims` emits a `v2` envelope using `active`, `openClaims` selects the named key, unknown key IDs fail closed, and `v1` ciphertext decrypts only when `legacy` is configured.

- [ ] **Step 2: Verify the tests fail**

Run: `vp test test/claims.test.ts`

Expected: failures because claims functions currently treat the input as one raw secret and emit `v1`.

- [ ] **Step 3: Implement minimal keyring support**

Parse and validate the JSON keyring in `src/crypto.ts`. Require an identifier-safe active key ID, a matching key of at least 32 characters, at most two named keys, and an optional legacy key of at least 32 characters. Bind the complete `v2.<kid>` prefix and caller context as AES-GCM additional data; preserve the old context-only additional data for legacy `v1` decryption.

- [ ] **Step 4: Verify claims tests pass**

Run: `vp test test/claims.test.ts`

Expected: all claims tests pass.

### Task 2: Independent Runtime Bindings

**Files:**

- Modify: `src/types.ts`
- Modify: `src/tokens.ts`
- Modify: `src/routes/oauth.ts`
- Modify: `src/routes/device.ts`
- Modify: `src/routes/account.ts`
- Test: `test/tokens.test.ts`
- Test: `test/oauth.test.ts`
- Test: `test/device.test.ts`
- Test: `test/account.test.ts`
- Test: `test/rate-limit.test.ts`

**Interfaces:**

- Produces: required `IDENTIFIER_SECRET`, `CLAIMS_ENCRYPTION_KEYRING`, and `RATE_LIMIT_SECRET` fields on `Env`.

- [ ] **Step 1: Rename test fixtures by responsibility**

Replace fixture `PAIRWISE_SECRET` values with all three new bindings. Update direct claim decryptions to pass `CLAIMS_ENCRYPTION_KEYRING`, subject expectations to use `IDENTIFIER_SECRET`, and rate-limit rotation tests to mutate `RATE_LIMIT_SECRET`.

- [ ] **Step 2: Verify focused tests fail to type-check or run**

Run: `vp test test/tokens.test.ts test/oauth.test.ts test/device.test.ts test/account.test.ts test/rate-limit.test.ts`

Expected: failures because production routes still read `PAIRWISE_SECRET`.

- [ ] **Step 3: Route each operation to its binding**

Use `IDENTIFIER_SECRET` only for `resolveIdentity`, `providerSubject`, and `pairwiseSubject`; use `CLAIMS_ENCRYPTION_KEYRING` only for `sealClaims` and `openClaims`; use `RATE_LIMIT_SECRET` only for `enforceRequestRateLimit`.

- [ ] **Step 4: Verify focused tests pass**

Run: `vp test test/tokens.test.ts test/oauth.test.ts test/device.test.ts test/account.test.ts test/rate-limit.test.ts`

Expected: all focused tests pass.

### Task 3: Configuration Contract

**Files:**

- Modify: `scripts/check-config.mjs`
- Modify: `.dev.vars.example`
- Modify: `wrangler.toml`
- Modify: `README.md`
- Test: `test/config.test.ts`

**Interfaces:**

- Produces: validation and operator instructions for all required secret bindings.

- [ ] **Step 1: Update config tests**

Require exact agreement across `Env`, the config checker, `.dev.vars.example`, and Wrangler comments for `IDENTIFIER_SECRET`, `CLAIMS_ENCRYPTION_KEYRING`, `RATE_LIMIT_SECRET`, and the signing binding. Add invalid keyring and short-secret cases.

- [ ] **Step 2: Verify config tests fail**

Run: `vp test test/config.test.ts`

Expected: failures naming the old bindings.

- [ ] **Step 3: Update checker and documentation**

Validate identifier/rate-limit minimum lengths and claims keyring shape. Document the rollout requirement to copy the old pairwise value into `IDENTIFIER_SECRET` and, for the first deployment, into `legacy` inside the claims keyring.

- [ ] **Step 4: Verify subsystem and commit**

Run: `vp test test/claims.test.ts test/tokens.test.ts test/oauth.test.ts test/device.test.ts test/account.test.ts test/rate-limit.test.ts test/config.test.ts`

Expected: all focused tests pass.

Commit: `feat: separate runtime secrets`
