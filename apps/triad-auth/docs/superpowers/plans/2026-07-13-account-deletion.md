# Account Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user delete every account-bound Triad row while preserving clients and deterministic identifier resurrection on a later login.

**Architecture:** Add one transactional D1 helper that deletes account-purpose CSRF records, authorization codes, device grants, consents, sessions, identities, and finally the account. Expose it through same-origin, session-authenticated, one-time-CSRF-protected `DELETE /api/me`, then clear the browser cookie and provide an explicit destructive confirmation UI.

**Tech Stack:** TypeScript 6, Hono, D1 batch transactions, Astro, Vitest through Vite+

## Global Constraints

- Keep deterministic account, provider, and pairwise subject derivation unchanged.
- Preserve global clients, rate limits, unrelated accounts, and unrelated protocol state.
- Already-issued ID tokens may remain valid for their existing five-minute lifetime.
- A later login with the same provider identity recreates the same identifiers with no old consent or session history.
- Do not touch `vite.config.ts`.
- Run `vp run check` and `vp run build`.

---

### Task 1: Transactional Account Erasure

**Files:**

- Modify: `src/db.ts`
- Test: `test/account.test.ts`
- Test: `test/identity.test.ts`

**Interfaces:**

- Produces: `deleteAccount(db: D1Database, accountId: string): Promise<boolean>`.

- [ ] **Step 1: Write failing deletion tests**

Seed two accounts plus account-bound authorization codes, device grants, consents, multiple sessions, identities, and account-purpose CSRF rows. Assert only the target account's rows disappear, clients/rate limits remain, and a missing account returns `false`. Add a resurrection test using `resolveIdentity`, `providerSubject`, and `pairwiseSubject` before and after deletion.

- [ ] **Step 2: Verify tests fail**

Run: `vp test test/account.test.ts test/identity.test.ts`

Expected: failure because `deleteAccount` does not exist.

- [ ] **Step 3: Implement ordered atomic deletion**

Use `db.batch` with statements in this order: delete CSRF purposes selected from target sessions, authorization codes, device grants, consents, browser sessions, identities, then `accounts`. Return whether the final account delete changed one row.

- [ ] **Step 4: Verify data-layer tests pass**

Run: `vp test test/account.test.ts test/identity.test.ts`

Expected: deletion and resurrection tests pass.

### Task 2: Protected Deletion Endpoint

**Files:**

- Modify: `src/routes/account.ts`
- Test: `test/account.test.ts`

**Interfaces:**

- Produces: `DELETE /api/me` accepting form-encoded `csrf_token` and returning `204` after clearing `triad_session`.

- [ ] **Step 1: Add failing route tests**

Cover wrong origin, missing session, invalid/replayed CSRF, successful deletion, all sessions invalidated, cookie clearing, and a second request returning `login_required`.

- [ ] **Step 2: Verify route tests fail**

Run: `vp test test/account.test.ts`

Expected: route returns 404.

- [ ] **Step 3: Add the endpoint**

Reuse `requireSameOrigin`, `requireSession`, and `authorizeMutation`; call `deleteAccount`; clear the secure Lax cookie exactly as logout does; return `204` on success and `login_required` if the account was already absent.

- [ ] **Step 4: Verify account tests pass**

Run: `vp test test/account.test.ts test/identity.test.ts`

Expected: all account and resurrection tests pass.

### Task 3: Destructive Account UI and Contract

**Files:**

- Modify: `src/pages/me.astro`
- Modify: `README.md`
- Test: `test/ui.test.ts`
- Test: `test/config.test.ts`

**Interfaces:**

- Produces: explicit `DELETE ACCOUNT`, confirmation, cancel, working, failure recovery, and success states.

- [ ] **Step 1: Add failing UI tests**

Require a separate deletion control, explicit consequence copy, a second confirmation action, a `DELETE /api/me` request using the current CSRF token, and inclusion in shared mutation disabling.

- [ ] **Step 2: Verify UI tests fail**

Run: `vp test test/ui.test.ts test/config.test.ts`

Expected: failures because the account page only supports consent revocation and logout.

- [ ] **Step 3: Implement the UI and documentation**

Add a bordered destructive region below sign-out. First action reveals exact consequences; confirm performs the request; cancel restores idle state. On success reload into signed-out state. Document deterministic resurrection, retained global clients, five-minute token lifetime, and no upstream-provider revocation.

- [ ] **Step 4: Verify and commit**

Run: `vp test test/account.test.ts test/identity.test.ts test/ui.test.ts test/config.test.ts`

Expected: all focused tests pass.

Commit: `feat: add account deletion`
