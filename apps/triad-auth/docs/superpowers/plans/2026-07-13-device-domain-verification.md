# Device Domain Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require every device client origin to prove HTTPS domain control through a Triad-specific well-known document before receiving a device grant.

**Architecture:** Fetch `/.well-known/triad-client.json` from the exact asserted origin with strict redirect, timeout, content, size, and schema checks. Cache successful proofs in D1 for one hour; failed proofs never create a grant. Triad serves its own proof dynamically for the built-in demo.

**Tech Stack:** TypeScript 6, Hono, Cloudflare Workers fetch, D1, Astro, Vitest through Vite+

## Global Constraints

- Production client origins require HTTPS; exact `http://localhost[:port]` remains a development exception.
- The proof must contain exact `issuer`, exact canonical `client_id`, `device_authorization: true`, and an optional display `name` of 1-80 characters.
- Verification requests use no redirects, a five-second timeout, JSON content type, and a 4096-byte response limit.
- Successful verification cache lifetime is one hour; no scheduled retention cleanup is added.
- Do not touch `vite.config.ts`.
- Run `vp run check` and `vp run build`.

---

### Task 1: Verification Cache

**Files:**

- Create: `migrations/0004_device_client_verifications.sql`
- Modify: `test/d1.ts`
- Test: `test/oauth.test.ts`

**Interfaces:**

- Produces: `device_client_verifications(client_id, name, verified_at, expires_at)` keyed by canonical origin.

- [ ] **Step 1: Add a failing sequential migration test**

Assert that migrations `0001` through `0004` produce the cache table with its primary key and expiry index.

- [ ] **Step 2: Verify it fails**

Run: `vp test test/oauth.test.ts`

Expected: failure because migration `0004` does not exist.

- [ ] **Step 3: Add and register the migration**

Create the table without an account/client foreign key so verification may occur before registration, and add `device_client_verifications_expiry_idx` on `expires_at`. Register the migration in `test/d1.ts`.

- [ ] **Step 4: Verify migration coverage passes**

Run: `vp test test/oauth.test.ts`

Expected: migration tests pass.

### Task 2: Strict Domain Verifier

**Files:**

- Create: `src/device-client.ts`
- Test: `test/device-client.test.ts`

**Interfaces:**

- Produces: `verifyDeviceClient(db: D1Database, clientId: string, issuer: string, fetcher?: typeof fetch): Promise<{ name: string }>`.

- [ ] **Step 1: Write failing verifier tests**

Cover exact valid proof, cache reuse, expiry refetch, issuer/client mismatch, disabled authorization, malformed JSON, non-JSON response, oversized response, redirects, timeout/network failure, invalid optional name, credentials in URL, non-origin paths, IP literals, local/internal hostnames, and the exact localhost exception.

- [ ] **Step 2: Verify tests fail**

Run: `vp test test/device-client.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement the verifier**

Canonicalize with `normalizeOriginClientId`, reject production IP literals and local/internal hostname forms, query an unexpired cache row, then fetch the exact well-known URL with `redirect: "error"` and an abort timer. Validate headers before reading, enforce the byte cap after reading, validate the JSON record, and upsert the one-hour cache row.

- [ ] **Step 4: Verify verifier tests pass**

Run: `vp test test/device-client.test.ts`

Expected: all verifier tests pass.

### Task 3: Device Issuance and First-Party Proof

**Files:**

- Modify: `src/routes/device.ts`
- Modify: `src/routes/oauth.ts`
- Test: `test/device.test.ts`

**Interfaces:**

- Consumes: `verifyDeviceClient` before client creation and grant insertion.
- Produces: `GET /.well-known/triad-client.json` for Triad's issuer origin.

- [ ] **Step 1: Add failing route tests**

Assert issuance succeeds only after proof, failed proof inserts neither client nor grant, cached proof avoids another fetch, and Triad's own proof contains the exact issuer origin.

- [ ] **Step 2: Verify route tests fail**

Run: `vp test test/device.test.ts`

Expected: requests still issue grants without domain proof.

- [ ] **Step 3: Integrate verification**

Run verification after provider/scope validation and before `getOrCreateOriginClient`. Convert verification failures to `invalid_client` without exposing network details. Add the dynamic well-known route.

- [ ] **Step 4: Verify device tests pass**

Run: `vp test test/device-client.test.ts test/device.test.ts test/protocol.test.ts`

Expected: all focused tests pass.

### Task 4: Verified-Origin Product Contract

**Files:**

- Modify: `src/pages/device/verify.astro`
- Modify: `src/pages/consent.astro`
- Modify: `README.md`
- Test: `test/ui.test.ts`
- Test: `test/config.test.ts`

**Interfaces:**

- Produces: device UI stating verified origin; browser consent UI stating callback-bound origin.

- [ ] **Step 1: Update UI contract tests**

Require `VERIFIED CLIENT ORIGIN` on device verification, remove the unverified warning, and require `CALLBACK-BOUND CLIENT ORIGIN` on browser consent.

- [ ] **Step 2: Verify UI tests fail**

Run: `vp test test/ui.test.ts test/config.test.ts`

Expected: failures on self-asserted copy and README limitations.

- [ ] **Step 3: Update surfaces and documentation**

Explain the exact well-known JSON, cache interval, removal behavior, localhost exception, and that already-issued grants/tokens are not revoked by removing the file.

- [ ] **Step 4: Verify and commit**

Run: `vp test test/device-client.test.ts test/device.test.ts test/protocol.test.ts test/ui.test.ts test/config.test.ts test/oauth.test.ts`

Expected: all focused tests pass.

Commit: `feat: verify device client domains`
