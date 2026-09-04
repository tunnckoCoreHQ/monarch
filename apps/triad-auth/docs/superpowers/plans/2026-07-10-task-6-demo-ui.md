# Task 6 Demo And Transactional UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build same-origin authorization-code PKCE and device demos that verify ES256 ID tokens in the browser, then make consent and device verification accurately disclose and protect the GitHub-only transaction.

**Architecture:** Astro continues to render static, accessible pages with page-local scripts. A focused `src/scripts/demo-protocol.ts` module owns browser PKCE generation and JOSE-backed discovery, JWKS, signature, issuer, audience, expiry, algorithm, key-selection, and identity-claim verification so both demo flows share one auditable implementation. Existing Hono protocol routes remain unchanged; the pages consume their current JSON and form interfaces.

**Tech Stack:** Astro 7, TypeScript 7, browser Web Crypto, JOSE 6, Vitest 3, Hono, D1 migrations, existing OKLCH/Archivo/JetBrains Mono design system.

## Global Constraints

- Preserve the established Shoo-influenced black-box switchboard design. Do not create a generic redesign.
- GitHub is the only provider in copy, navigation, controls, and seeded client provider allowlists.
- Use JOSE in the browser bundle rather than hand-rolled JWT cryptography.
- Store only the authorization-code verifier and state in `sessionStorage`.
- Reject callback state mismatch before token exchange or discovery/JWKS fetches.
- Device polling starts at the server-provided interval, adds five seconds on `slow_down`, and stops on success, denial, terminal error, or expiry.
- Consent and device mutations submit the CSRF token fetched for the exact transaction.
- Disclose that `provider_sub` is stable and globally correlatable across Triad clients that receive it.
- Keep visible keyboard focus, 44px or larger controls, mobile structural reflow, text-plus-shape status, and reduced-motion behavior.
- Include loading, error, and success states without layout collapse.
- Use no em dashes in authored UI copy.
- `triad-demo` is the sole local downstream demo client and its exact local redirect URI is `http://localhost:8787/demo/callback/`; the deployment URI remains intentionally unresolved.
- Regenerate CSP script hashes through `pnpm build`.

---

### Task 1: Lock The Static UI And Client Contract With Failing Tests

**Files:**

- Create: `test/ui.test.ts`
- Modify: `test/oauth.test.ts`
- Modify: `test/device.test.ts`
- Modify: `migrations/0001_init.sql`

**Interfaces:**

- Consumes: Astro output under `dist/` and migration-backed `clients` rows.
- Produces: assertions for `/demo/`, `/demo/callback/`, GitHub-only rendered copy, CSRF form fields, and the exact `triad-demo` registration.

- [ ] **Step 1: Write the failing static build assertions**

```ts
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("builds both demo entry points", async () => {
  await expect(readFile("dist/demo/index.html", "utf8")).resolves.toContain("TRY THE BROKER");
  await expect(readFile("dist/demo/callback/index.html", "utf8")).resolves.toContain(
    "VERIFYING IDENTITY",
  );
});
```

- [ ] **Step 2: Run the prescribed red phase**

Run: `pnpm build && pnpm vitest run test/ui.test.ts`

Expected: FAIL because `dist/demo/index.html` and `dist/demo/callback/index.html` do not exist.

- [ ] **Step 3: Replace the development seed with the exact demo client**

```sql
INSERT INTO clients (client_id, name, redirect_uris, providers, created_at)
VALUES ('triad-demo', 'Triad demo', '["http://localhost:8787/demo/callback/"]', '["github"]', unixepoch());
```

Keep `triad-account` as the broker's internal session client, but change its provider allowlist to `["github"]`. Update protocol test fixtures from `local-dev` and port 3000 to `triad-demo` and the exact port-8787 callback.

- [ ] **Step 4: Add migration contract assertions**

Extend `test/ui.test.ts` to read `migrations/0001_init.sql` and assert that it contains the exact `triad-demo` row and does not contain `'local-dev'`, `localhost:3000`, or provider arrays containing Google/X.

- [ ] **Step 5: Run focused database-backed tests**

Run: `pnpm vitest run test/ui.test.ts test/oauth.test.ts test/device.test.ts`

Expected: UI entry-point assertions remain red; OAuth and device tests pass with the renamed client.

---

### Task 2: Build And Test Browser Protocol Helpers

**Files:**

- Create: `src/scripts/demo-protocol.ts`
- Create: `test/demo-protocol.test.ts`

**Interfaces:**

- Consumes: `globalThis.crypto`, same-origin OIDC discovery, JWKS JSON, and JOSE `decodeProtectedHeader`, `importJWK`, and `jwtVerify`.
- Produces: `createPkce(): Promise<{ verifier: string; challenge: string; state: string }>` and `verifyIdentityToken(token: string, clientId: string, brokerOrigin?: string): Promise<VerifiedIdentity>`.

- [ ] **Step 1: Write failing PKCE tests**

Assert that `createPkce()` creates an 86-character base64url verifier from 64 random bytes, a 43-character SHA-256 challenge matching an independent digest, and a non-repeating base64url state.

- [ ] **Step 2: Run the focused red phase**

Run: `pnpm vitest run test/demo-protocol.test.ts`

Expected: FAIL because `src/scripts/demo-protocol.ts` does not exist.

- [ ] **Step 3: Implement PKCE with Web Crypto**

Use `crypto.getRandomValues(new Uint8Array(64))` for the verifier, `crypto.getRandomValues(new Uint8Array(32))` for state, and `crypto.subtle.digest("SHA-256", ...)` for the challenge. Base64url encoding may encode random bytes and digest bytes only; it must not parse or verify JWTs.

- [ ] **Step 4: Write failing JOSE verification tests**

Generate an ES256 key pair with JOSE, mock discovery and JWKS fetches, sign a valid token, and assert all returned claims. Add rejections for a missing/mismatched `kid`, non-ES256 header, wrong issuer, wrong audience, expired token, non-string identity claims, and `sub !== pairwise_sub`.

- [ ] **Step 5: Implement verified identity parsing**

Fetch `${brokerOrigin}/.well-known/openid-configuration`, fetch its `jwks_uri`, select the single key matching the protected header `kid` with `kty: "EC"`, `crv: "P-256"`, `use: "sig"`, and `alg: "ES256"`, call `importJWK(key, "ES256")`, then call `jwtVerify` with `algorithms: ["ES256"]`, the discovery issuer, and audience `triad-demo`. Return only checked string claims:

```ts
interface VerifiedIdentity {
  pairwiseSub: string;
  accountSub: string;
  providerSub: string;
  issuer: string;
  expiresAt: number;
}
```

- [ ] **Step 6: Run helper tests**

Run: `pnpm vitest run test/demo-protocol.test.ts`

Expected: PASS.

---

### Task 3: Build The Authorization-Code And Device Demo Surfaces

**Files:**

- Create: `src/pages/demo/index.astro`
- Create: `src/pages/demo/callback.astro`
- Modify: `src/styles/global.css`
- Test: `test/ui.test.ts`

**Interfaces:**

- Consumes: `createPkce`, `verifyIdentityToken`, discovery `authorization_endpoint`, discovery `token_endpoint`, discovery `device_authorization_endpoint`, `sessionStorage`, and the exact callback URI derived as `${location.origin}/demo/callback/`.
- Produces: an authorization-code launch control, callback verification result, device grant launcher, verification link, expiry-aware poller, and verified three-row identity rendering.

- [ ] **Step 1: Extend failing static assertions**

Assert built HTML includes `triad-demo`, `provider=github`, `code_challenge_method`, the device grant type, `authorization_pending`, `slow_down`, all three identity names, clear provider correlation copy, live status regions, and no Google/X provider controls.

- [ ] **Step 2: Build `/demo/` in the existing switchboard vocabulary**

Create one strong transaction heading followed by two hard-rule demo bays. The browser bay has a single `SIGN IN WITH GITHUB` button and exact PKCE disclosure. The device bay has `START DEVICE FLOW`, then progressively reveals a selectable user code, exact verification link, expiry/status text, and a verified identity ledger on success. Keep each bay's status in an `aria-live="polite"` region and move focus to actionable error/success headings only when state changes require it.

- [ ] **Step 3: Implement browser launch**

Fetch discovery, generate PKCE, write only `triad_demo_verifier` and `triad_demo_state` to session storage, and navigate to discovery's authorization endpoint with `client_id=triad-demo`, exact callback, `response_type=code`, `provider=github`, `scope=openid`, state, challenge, and `code_challenge_method=S256`.

- [ ] **Step 4: Implement device launch and polling**

POST form-encoded `client_id=triad-demo`, `provider=github`, and `scope=openid` to the discovered device endpoint. Poll the token endpoint using the device grant type at the advertised interval, increase the local interval by five seconds for every `slow_down`, continue for `authorization_pending`, and stop timers on success, `access_denied`, `expired_token`, unknown terminal error, or local expiry. Verify the returned ID token before rendering any identity values.

- [ ] **Step 5: Build `/demo/callback/` with state-first rejection**

Read the expected state and verifier from session storage. Reject missing/mismatched state and clear storage before any token/discovery call. On a valid callback, clear storage, exchange the code at `/token`, verify the ID token with `verifyIdentityToken`, and render three labeled rows: pairwise app identity, broker account identity, and globally correlatable GitHub provider identity. Render provider denial, malformed callbacks, exchange failures, and verification failures as stable recovery states linking back to `/demo/`.

- [ ] **Step 6: Extend CSS without redesigning**

Add square `.demo-*`, `.status-*`, and `.verified-*` treatments using existing tokens, one-dimensional rules, display headings, mono protocol values, 48px controls, `overflow-wrap: anywhere`, visible focus, structural mobile stacking below 760px, and no decorative motion.

- [ ] **Step 7: Run the static acceptance cycle**

Run: `pnpm build && pnpm vitest run test/ui.test.ts && pnpm typecheck`

Expected: PASS and CSP hashes regenerate from all built pages.

---

### Task 4: Make Consent And Device Verification CSRF-Aware And GitHub-Only

**Files:**

- Modify: `src/pages/consent.astro`
- Modify: `src/pages/device/verify.astro`
- Modify: `test/ui.test.ts`

**Interfaces:**

- Consumes: `csrf_token` from `GET /api/consent/:request` and `GET /api/device/:code`.
- Produces: form-encoded same-origin mutation requests containing the fetched token, and GitHub-only transactional controls/copy.

- [ ] **Step 1: Add failing output assertions**

Assert the consent script sends `application/x-www-form-urlencoded` with `csrf_token`, consent copy uses the phrase `globally correlatable`, the device form contains hidden `provider=github` and `csrf_token`, and neither page contains Google or X controls.

- [ ] **Step 2: Fix consent mutation state**

Capture `csrf_token` from consent inspection. Send it in a `URLSearchParams` body with the correct content type for approve and deny. Show loading labels while mutating, preserve a stable panel, use clear retry/restart guidance on failure, and disclose all three received identity semantics including the global cross-client correlation property of `provider_sub`.

- [ ] **Step 3: Fix device verification state**

Replace provider radio choices with a fixed hidden GitHub provider value. Add a hidden CSRF input populated only after a successful code inspection. Keep submit disabled until inspection succeeds; clear the client and CSRF state whenever the code changes; expose loading, invalid, ready, and submission states with `aria-busy` and live text.

- [ ] **Step 4: Run the focused UI cycle**

Run: `pnpm build && pnpm vitest run test/ui.test.ts && pnpm typecheck`

Expected: PASS.

---

### Task 5: Align Global GitHub-Only Navigation And Copy

**Files:**

- Modify: `src/components/Shell.astro`
- Modify: `src/pages/index.astro`
- Modify: `src/styles/global.css`
- Modify: `test/ui.test.ts`

**Interfaces:**

- Consumes: existing global shell and landing-page sections.
- Produces: discoverable `/demo/` navigation and GitHub-only marketing/protocol copy with no em dashes.

- [ ] **Step 1: Add failing shell and copy assertions**

Assert `/demo/` is present in shell navigation, all built application HTML is free of Google, Twitter, X-provider, and em-dash copy, and the landing page links to the working demo.

- [ ] **Step 2: Update the shell**

Change the default description and footer to GitHub-only language, add `DEMO` navigation, preserve discovery/source access, and make mobile navigation retain the demo and GitHub source links without relying on child order.

- [ ] **Step 3: Update the landing page**

Replace three-provider claims and examples with the GitHub MVP's actual boundary, point the primary local product action to `/demo/`, retain the source action, and describe `provider_sub` as globally correlatable across receiving Triad clients. Replace em dashes with hyphens or sentence punctuation.

- [ ] **Step 4: Run UI checks**

Run: `pnpm build && pnpm vitest run test/ui.test.ts && pnpm typecheck`

Expected: PASS.

---

### Task 6: Full Verification, Self-Review, Report, And Commit

**Files:**

- Modify: `src/generated/csp-script-hashes.ts` through `pnpm build`
- Create: `.superpowers/sdd/task-6-report.md`

**Interfaces:**

- Consumes: all Task 6 implementation and test output.
- Produces: verified build artifacts, regenerated CSP allowlist, review notes, final report, and one feature commit.

- [ ] **Step 1: Run the complete required checks**

Run: `pnpm build`

Run: `pnpm vitest run test/ui.test.ts`

Run: `pnpm test`

Run: `pnpm typecheck`

Expected: all commands exit 0.

- [ ] **Step 2: Inspect the final diff and generated output**

Run: `git diff --check`

Run: `git status --short`

Run: `git diff --stat`

Review security order (state before network), JOSE verification options, device timer cancellation, CSRF body encoding, exact redirect URI, focus/live-region behavior, mobile rules, copy accuracy, provider removal, and generated CSP hashes.

- [ ] **Step 3: Write the report**

Record implementation status, exact commands and results, self-review findings/fixes, commit message, and any deployment-only concern in `.superpowers/sdd/task-6-report.md`. The production callback URI remains a deployment concern and must not be invented locally.

- [ ] **Step 4: Commit intended Task 6 files**

```bash
git add docs/superpowers/plans/2026-07-10-task-6-demo-ui.md .superpowers/sdd/task-6-report.md migrations/0001_init.sql src/components/Shell.astro src/generated/csp-script-hashes.ts src/pages src/scripts/demo-protocol.ts src/styles/global.css test/demo-protocol.test.ts test/device.test.ts test/oauth.test.ts test/ui.test.ts
git commit -m "feat: add interactive broker demos"
```

- [ ] **Step 5: Verify the commit**

Run: `git status --short`

Run: `git log -1 --oneline`

Expected: the intended files are committed, no Task 6 changes remain uncommitted, and unrelated pre-existing worktree changes remain untouched.
