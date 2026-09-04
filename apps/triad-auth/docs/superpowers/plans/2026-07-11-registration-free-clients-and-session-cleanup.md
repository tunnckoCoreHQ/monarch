# Registration-Free Clients and Session Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship URL-origin clients without mandatory registration, seven-day D1 browser sessions, no Astro session KV binding, and intact mobile display phrases.

**Architecture:** Keep existing registered clients as a concrete compatibility path for Triad's internal account flow and existing prototype data. Add a registration-free path that canonicalizes redirect origins, upserts minimal client rows for existing foreign keys, and uses the canonical origin as token audience and pairwise namespace. Continue storing broker sessions in D1 and explicitly select Astro's in-memory driver only to suppress adapter KV provisioning.

**Tech Stack:** TypeScript 6, Hono, Astro 7, `@astrojs/cloudflare`, Cloudflare Workers/D1, Vite+.

## Global Constraints

- Do not add regression tests.
- Update existing assertions only where the prototype contract changes.
- Keep mandatory S256 PKCE, exact redirect binding on authorization codes, and provider availability checks.
- Keep `triad-account` as an internal registered client.
- Browser sessions expire after exactly seven days.
- Use focused commits and push each commit immediately.
- Run `vp test`, `vp run check`, and `vp run build` before deployment.

---

### Task 1: Registration-free URL-origin clients

**Files:**

- Modify: `src/db.ts`
- Modify: `src/routes/oauth.ts`
- Modify: `src/routes/device.ts`
- Modify existing fixtures only as required: `test/oauth.test.ts`, `test/device.test.ts`

**Interfaces:**

- Produces: `clientIdFromRedirect(redirectUri: string): string`.
- Produces: `getOrCreateOriginClient(db: D1Database, clientId: string): Promise<ClientRow>`.
- Preserves: `getClient` and registered-client validation for internal/legacy rows.

- [ ] Add origin parsing that accepts HTTPS origins and `http://localhost[:port]`, rejects credentials, paths, queries, and fragments when parsing direct device client IDs, and derives an origin from browser redirect URIs.
- [ ] Add an `INSERT OR IGNORE` client upsert with hostname display name, empty redirect list, and all three provider adapters.
- [ ] Make `/authorize` derive the client ID when omitted. If an explicit client ID equals the redirect origin, use the dynamic row; otherwise preserve registered-client exact-redirect validation.
- [ ] Restructure `/token` so authorization-code exchange can derive an omitted client ID from `redirect_uri`, while device exchange continues requiring its stored explicit client ID.
- [ ] Let `/device/code` create a missing valid origin client while preserving existing registered clients.
- [ ] Run existing OAuth and device tests, changing only obsolete request expectations.
- [ ] Commit and push with subject `feat: add registration-free origin clients`.

### Task 2: Demo and documentation contract

**Files:**

- Modify: `src/pages/index.astro`
- Modify: `src/pages/demo/index.astro`
- Modify: `src/pages/demo/callback.astro`
- Modify: `README.md`
- Modify existing source assertions only as required: `test/ui.test.ts`, `test/config.test.ts`, `test/demo-protocol.test.ts`

**Interfaces:**

- Browser demo client ID is `window.location.origin`.
- Landing browser example omits `client_id` and uses an HTTPS callback.
- Device demo submits the same origin explicitly.

- [ ] Replace the landing sample with provider, HTTPS redirect, PKCE challenge, and S256 method parameters; explain that Triad derives identity from the callback origin.
- [ ] Set demo and callback token verification audience to the current broker origin instead of `triad-demo`.
- [ ] Keep the device request's explicit client ID, now using the current origin.
- [ ] Remove registration-first README language and document browser derivation plus self-asserted device origins.
- [ ] Run existing UI and protocol-helper tests, updating only obsolete string expectations.
- [ ] Commit and push with subject `docs: explain origin client identity`.

### Task 3: Seven-day sessions and KV removal

**Files:**

- Modify: `astro.config.mjs`
- Modify: `src/routes/oauth.ts`
- Modify: `README.md`
- Modify existing expectations: `test/account.test.ts`, `test/config.test.ts`

**Interfaces:**

- Broker session duration: `60 * 60 * 24 * 7` seconds.
- Astro adapter has a non-KV session driver and emits no `SESSION` binding.

- [ ] Import `sessionDrivers` from `astro/config` and configure `session: { driver: sessionDrivers.lruCache() }`, with a short comment that broker sessions remain D1-backed.
- [ ] Introduce one seven-day browser-session duration constant and use it for both D1 expiry and cookie `Max-Age`.
- [ ] Update existing 30-day assertions and current documentation to seven days.
- [ ] Run `vp run build` and inspect `dist/server/wrangler.json`; fail the task if it still contains `SESSION` or a KV namespace.
- [ ] Commit and push with subject `fix: use seven-day broker sessions`.

### Task 4: Mobile phrase composition

**Files:**

- Modify: `src/pages/demo/index.astro` only if phrase wrappers are required.
- Modify: `src/styles/global.css`

**Interfaces:**

- Landing: `THAT WORKS.` remains one phrase.
- Demo: `ONE REQUEST.` and `TWO FLOWS.` remain two phrase lines.

- [ ] Apply non-wrapping phrase behavior and mobile-specific sizes that fit at 320px without horizontal overflow.
- [ ] Preserve desktop line breaks and signal coloring.
- [ ] Build and inspect generated HTML/CSS rules for 320px mobile and 1440px desktop compositions.
- [ ] Commit and push with subject `fix: preserve mobile display phrases`.

### Task 5: Release and resource cleanup

**Files:**

- Modify only files required by verification failures.

**Interfaces:**

- Live Worker has D1 and Assets bindings but no `SESSION` KV binding.

- [ ] Run `vp test`, `vp run check`, and `vp run --no-cache build`.
- [ ] Request an independent review focused on dynamic-client trust boundaries, token binding, session expiry, generated bindings, and mobile overflow.
- [ ] Deploy with `vp run --no-cache deploy` and record the Worker version.
- [ ] Smoke-test browser authorization without `client_id`, device issuance with an origin client ID, landing/demo/CSS, discovery, JWKS, providers, and seven-day session-cookie behavior.
- [ ] Confirm the deployed Worker no longer binds `SESSION`.
- [ ] Delete KV namespace `975d1ea60ad34f478da8821feccbb452` only after the binding-free deployment is live.
- [ ] Confirm the namespace is absent and the live Worker remains healthy.
