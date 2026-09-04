# Product Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Triad's copy and consent UI, simplify opaque IDs, and apply the repository clean-code rules before deploying.

**Architecture:** Keep the existing Hono routes and mandatory scope behavior. Share disclosure-control rendering between browser and device consent, with checked disabled controls representing the client's fixed request. Derived identifiers change format without a database migration.

**Tech Stack:** TypeScript 7, Hono, Astro 7, D1, Vitest, Wrangler, Prettier.

## Global Constraints

- The core identity claims remain fixed behind `openid`; requested profile claims are mandatory and displayed as checked, disabled controls.
- New subjects use `ps_<32 lowercase hex>` and `pid_<provider>_<32 lowercase hex>`.
- Keep `subject_types_supported: ["pairwise"]`, scope `avatar`, and claim `picture`.
- Retain WCAG 2.2 AA behavior, keyboard focus, reduced motion, and responsive layouts.
- Follow `AGENTS.md`: clear names, early returns, focused functions, narrow types, and no unrelated compatibility code.
- Do not enable Twitter without a complete credential pair.

---

### Task 1: Compact opaque subjects

**Files:**

- Modify: `src/crypto.ts`
- Modify: `src/tokens.ts`
- Test: `test/identity.test.ts`
- Test: `test/tokens.test.ts`
- Test: fixture strings in `test/**/*.test.ts`

**Interfaces:**

- Produces: `pairwiseSubject(secret, accountId, clientId): Promise<string>` returning `ps_<hex>`.
- Produces: `providerSubject(secret, provider, providerUserId): Promise<string>` returning `pid_<provider>_<hex>`.

- [ ] **Step 1: Update subject tests to require lowercase hexadecimal bodies**

```ts
expect(await pairwiseSubject(secret, "acct_a", "client_a")).toMatch(/^ps_[0-9a-f]{32}$/);
expect(await providerSubject(secret, "github", "277398031")).toMatch(/^pid_github_[0-9a-f]{32}$/);
```

- [ ] **Step 2: Run the focused tests and confirm old base64url output fails**

Run: `pnpm test -- test/identity.test.ts test/tokens.test.ts`

Expected: failures referencing `prv_` and the old provider-subject validation regex.

- [ ] **Step 3: Add explicit HMAC bytes and hexadecimal encoding**

```ts
function hexadecimal(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Bytes(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function pairwiseSubject(
  secret: string,
  accountId: string,
  clientId: string,
): Promise<string> {
  const digest = await hmacSha256Bytes(secret, `${accountId}\0${clientId}`);
  return `ps_${hexadecimal(digest.slice(0, 16))}`;
}
```

Use the same 16-byte hexadecimal body for `pid_${provider}_...`; retain `hmacSha256()` for callers that require base64url hashes.

- [ ] **Step 4: Update token validation and all fixed fixtures**

```ts
if (!/^pid_(google|github|twitter)_[0-9a-f]{32}$/.test(providerSub)) {
  throw new Error("provider_sub must be an opaque Triad provider subject");
}
```

- [ ] **Step 5: Run focused tests**

Run: `pnpm test -- test/identity.test.ts test/tokens.test.ts test/demo-protocol.test.ts`

Expected: all focused tests pass.

### Task 2: Mandatory scope preservation

**Files:**

- Modify: `src/routes/oauth.ts`
- Modify: `src/routes/device.ts`
- Test: `test/oauth.test.ts`
- Test: `test/device.test.ts`

**Interfaces:**

- Preserves: requested scopes pass unchanged through browser and device approval.

- [ ] **Step 1: Add route tests for mandatory preservation**

```ts
expect(transaction.scopes).toBe('["openid","email","name"]');
expect(token.scope).toBe("openid email name");
```

Add authorization-code and device tests that request `openid email name`, approve the request, and assert stored/returned scope remains exactly `openid email name`.

- [ ] **Step 2: Run focused tests and confirm failures**

Run: `pnpm test -- test/oauth.test.ts test/device.test.ts`

Expected: failures if either approval flow alters requested scopes.

- [ ] **Step 3: Keep approval bound to requested scopes**

On browser approval, parse `row.scopes`, pass them to `startProvider`, and preserve `row.scopes` in `oauth_transactions`. On device approval, parse `grant.scopes`, pass them to the provider, and preserve `grant.scopes` in the transaction.

At device callback, preserve the original grant scopes so token exchange returns the complete mandatory request.

- [ ] **Step 5: Run focused tests**

Run: `pnpm test -- test/oauth.test.ts test/device.test.ts`

Expected: all focused tests pass with the complete request preserved.

### Task 3: Consent, device, and demo controls

**Files:**

- Create: `src/scripts/disclosure-controls.ts`
- Modify: `src/pages/consent.astro`
- Modify: `src/pages/device/verify.astro`
- Modify: `src/pages/demo/index.astro`
- Modify: `src/pages/demo/callback.astro`
- Modify: `src/styles/global.css`
- Test: `test/ui.test.ts`

**Interfaces:**

- Produces: `renderDisclosureControls(container, scopes): void`.
- Preserves: browser/device approval requests submit one approve-or-cancel decision without changing scopes.

- [ ] **Step 1: Replace obsolete static-markup tests with control semantics**

Assert that `openid` is a fixed disclosure, requested profile scopes render checked disabled switches, provider configuration uses a `<select>`, successful result headings are not programmatically focused, and profile headings read `SHARED CLAIMS`.

- [ ] **Step 2: Run UI tests and confirm failures**

Run: `pnpm test -- test/ui.test.ts`

Expected: failures against the current static consent list and radio-style provider selector.

- [ ] **Step 3: Add the shared disclosure renderer**

Render the three identity rows without switches and one checked disabled switch for each mandatory requested profile scope, using user-facing descriptions.

- [ ] **Step 4: Wire browser and device approval**

Import the shared renderer from each Astro script. Submit only the transaction CSRF and fixed provider binding; the server retains the original requested scopes. Remove controls whenever an inspected request is reset.

- [ ] **Step 5: Clarify demo controls and successful results**

Replace generated provider radios with one labeled `<select id="demo-provider">`; update capability lookup and locking to use its value. Rename both profile result headings to `SHARED CLAIMS` and remove success-heading `.focus()` calls and `tabindex="-1"`.

- [ ] **Step 6: Style the select and switches responsively**

Use existing rule, surface, signal, focus, and minimum-target tokens. A switch must show both text and shape state; mobile disclosure rows collapse to one column without hiding the control.

- [ ] **Step 7: Run UI and protocol tests**

Run: `pnpm test -- test/ui.test.ts test/demo-protocol.test.ts`

Expected: all tests pass.

### Task 4: Product copy and coral visual pass

**Files:**

- Modify: `src/components/Shell.astro`
- Modify: `src/pages/index.astro`
- Modify: `src/pages/consent.astro`
- Modify: `src/pages/device/verify.astro`
- Modify: `src/pages/me.astro`
- Modify: `src/styles/global.css`
- Modify: `PRODUCT.md`
- Modify: `DESIGN.md`
- Modify: `README.md`
- Test: `test/ui.test.ts`
- Test: `test/config.test.ts`

**Interfaces:**

- Keeps all route URLs unchanged.
- Documents `avatar` request scope mapping to the standard `picture` claim.

- [ ] **Step 1: Update copy expectations**

Require `IDENTITY, THAT WORKS`, `IDENTITY HANDSHAKE`, `CHECK THE CONNECTION`, real footer anchors, no `ME` nav anchor, `pid_` examples, and no `BROKER UPSTREAM`, `NO KEYBOARD`, `VERIFIED OPTIONAL CLAIMS`, or developer-facing email warning.

- [ ] **Step 2: Run copy tests and confirm failures**

Run: `pnpm test -- test/ui.test.ts test/config.test.ts`

Expected: failures naming old copy and color documentation.

- [ ] **Step 3: Rewrite landing and transaction copy**

Use `IDENTITY, / THAT WORKS.` for the hero. Describe choosing a provider, approving a connection, local verification, and authorizing another device. Explain consent as a choice over requested profile claims.

- [ ] **Step 4: Update navigation, footer, and account spacing**

Keep `DEMO`, `DISCOVERY`, and `SOURCE` in the header. Footer anchors are `TRY TRIAD`, `DISCOVERY`, `ACCOUNT`, and `SOURCE`. Add an `account-actions` class with visible margin above sign out.

- [ ] **Step 5: Change signal color and documentation**

Set `--signal: oklch(0.72 0.19 38)` and `--signal-ink: oklch(0.11 0.02 38)`. Update `DESIGN.md` consent behavior and palette, `PRODUCT.md` positioning, and README scope/claim and OIDC `pairwise` explanations.

- [ ] **Step 6: Run copy tests**

Run: `pnpm test -- test/ui.test.ts test/config.test.ts`

Expected: all tests pass.

### Task 5: Repository formatting, verification, and release

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `vite.config.ts`
- Create: `src/env.d.ts`
- Modify: all supported project text files through Vite+ Oxfmt and Oxlint
- Add: `AGENTS.md`

**Interfaces:**

- Produces: Vite+ format, lint, type-check, test, build, and task workflows.
- Changes: `vp run check` includes formatting, linting, type checking, and a Wrangler dry-run.

- [ ] **Step 1: Migrate the project to Vite+**

Run: `vp migrate --no-interactive --no-agent --no-hooks --no-editor`

Configure Vite+ to use TypeScript 6, the Vite+ test import, Oxfmt, type-aware Oxlint, and the required task commands.

Ignore generated and secret paths: `dist`, `.astro`, `.wrangler`, `node_modules`, `.dev.vars`, and `src/generated`.

- [ ] **Step 2: Format the repository and inspect the diff**

Run: `vp run check`

Expected: supported files are consistently formatted; secrets and generated output are untouched.

- [ ] **Step 3: Run the complete verification suite**

Run: `vp run check && vp run test && vp run build`

Expected: formatting, type-aware linting, type checking, Astro build, all Vite+ tests, config validation, and Wrangler dry-run pass.

- [ ] **Step 4: Validate responsive browser surfaces**

Run the local Worker and inspect landing, demo, consent, device verification, callback success, and account at desktop and mobile widths. Confirm no overflow, focus ring on keyboard use, real switches, select semantics, and spacing above sign out.

- [ ] **Step 5: Review, commit, push, and deploy**

Inspect `git status`, `git diff`, and recent commits; commit only intended files using lowercase Conventional Commit subjects. Push `main`, run `vp run deploy`, and record the Worker version.

- [ ] **Step 6: Smoke-test production**

Verify `/api/providers`, discovery, JWKS, landing, demo, consent redirect, and Google/GitHub upstream redirects. Confirm Twitter remains absent without credentials.
