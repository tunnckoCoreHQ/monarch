# Privacy Results and Identifiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship explicit privacy defaults, factual consent ledgers, a clearer callback result, and stable full-hex public subjects.

**Architecture:** Keep the existing Hono, Astro, D1, and browser-script boundaries. Centralize subject derivation in `src/crypto.ts`, pass the pairwise secret into account resolution, reset prototype identity state with a forward migration, and reuse existing ledger primitives for all UI changes.

**Tech Stack:** TypeScript 6, Hono, Astro, Cloudflare Workers and D1, Web Crypto HMAC-SHA-256, Vite+ Test, Oxfmt, Oxlint.

## Global Constraints

- Do not modify `vite.config.ts`.
- Keep Google, GitHub, and Twitter as canonical provider names; never use `x` internally.
- Keep provider and pairwise subjects stable and domain-separated with HMAC-SHA-256.
- Use `pid_<provider>_<64 lowercase hex>`, `acc_<64 lowercase hex>`, and `pws_<64 lowercase hex>`.
- Keep profile scopes mandatory once requested; consent approves or cancels the complete request.
- Preserve keyboard focus, live regions, minimum touch targets, and reduced-motion behavior.
- Do not alter the demo's provider capability controls.
- Push every focused commit immediately.
- Run `vp run check` and `vp run build` before deployment.

---

### Task 1: Stable full-hex subjects and prototype reset

**Files:**

- Modify: `test/identity.test.ts`
- Modify: `test/tokens.test.ts`
- Modify: `test/oauth.test.ts`
- Modify: `src/crypto.ts`
- Modify: `src/db.ts`
- Modify: `src/routes/oauth.ts`
- Create: `migrations/0003_reset_subject_formats.sql`
- Modify: `README.md`

**Interfaces:**

- Produces: `accountSubject(secret: string, provider: ProviderName, providerUserId: string): Promise<string>`.
- Changes: `resolveIdentity(db: D1Database, identity: ProviderIdentity, secret: string): Promise<string>`.
- Preserves: `providerSubject` and `pairwiseSubject` signatures while changing output formats.

- [ ] **Step 1: Write failing subject-format tests**

Update identity tests to require full domain-separated output:

```ts
const account = await accountSubject(secret, "github", "277398031");
const provider = await providerSubject(secret, "github", "277398031");
const pairwise = await pairwiseSubject(secret, account, "triad-demo");

expect(account).toMatch(/^acc_[0-9a-f]{64}$/);
expect(provider).toMatch(/^pid_github_[0-9a-f]{64}$/);
expect(pairwise).toMatch(/^pws_[0-9a-f]{64}$/);
expect(new Set([account.slice(4), provider.slice(11), pairwise.slice(4)]).size).toBe(3);
```

Pass `secret` to both concurrent `resolveIdentity` calls and assert their account matches `acc_[0-9a-f]{64}`.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `vp test test/identity.test.ts test/tokens.test.ts`

Expected: failures for missing `accountSubject`, old `ps_` output, 32-character bodies, and old token validation.

- [ ] **Step 3: Implement domain-separated full HMAC output**

Expose the existing hexadecimal conversion across complete digests:

```ts
export async function accountSubject(
  secret: string,
  provider: ProviderName,
  providerUserId: string,
): Promise<string> {
  const digest = await hmacSha256Bytes(secret, `account-sub\0${provider}:${providerUserId}`);

  return `acc_${hexadecimal(digest)}`;
}
```

Change provider output to `pid_${provider}_${hexadecimal(digest)}` and pairwise output to `pws_${hexadecimal(digest)}`. Keep distinct `account-sub`, `provider-sub`, and `pairwise-sub` domain labels.

In `resolveIdentity`, derive the candidate account from `accountSubject(secret, identity.provider, identity.id)` instead of `randomToken`. Update every `resolveIdentity` call in `src/routes/oauth.ts` to pass `c.env.PAIRWISE_SECRET`.

- [ ] **Step 4: Add the destructive prototype migration**

Create `migrations/0003_reset_subject_formats.sql` with foreign-key-safe deletion:

```sql
DELETE FROM csrf_tokens;
DELETE FROM browser_sessions;
DELETE FROM consent_requests;
DELETE FROM oauth_transactions;
DELETE FROM authorization_codes;
DELETE FROM device_grants;
DELETE FROM consents;
DELETE FROM identities;
DELETE FROM accounts;
```

Do not delete `clients`, `rate_limits`, or provider configuration.

- [ ] **Step 5: Update validators and documentation**

Require `pid_(google|github|twitter)_[0-9a-f]{64}` in `src/tokens.ts`. Update test fixtures and README format examples to the new prefixes and body lengths.

- [ ] **Step 6: Verify and push the focused commit**

Run: `vp test test/identity.test.ts test/tokens.test.ts test/oauth.test.ts test/account.test.ts test/device.test.ts`

Expected: all selected tests pass.

Commit and push:

```bash
git add src/crypto.ts src/db.ts src/routes/oauth.ts src/tokens.ts test/identity.test.ts test/tokens.test.ts test/oauth.test.ts test/account.test.ts test/device.test.ts migrations/0003_reset_subject_formats.sql README.md
git commit -m "feat: standardize opaque subject formats"
git push origin main
```

### Task 2: Factual authorization disclosure ledgers

**Files:**

- Modify: `test/ui.test.ts`
- Modify: `src/scripts/disclosure-controls.ts`
- Modify: `src/pages/consent.astro`
- Modify: `src/pages/device/verify.astro`
- Modify: `src/styles/global.css`

**Interfaces:**

- Renames: `renderDisclosureControls(container, scopes)` to `renderDisclosures(container, scopes)`.
- Produces: static disclosure rows containing label, claim, and description only.

- [ ] **Step 1: Write the failing disclosure test**

Replace switch assertions with factual-ledger assertions:

```ts
expect(controls).toContain("export function renderDisclosures");
expect(controls).not.toContain('document.createElement("input")');
expect(controls).not.toContain("disclosure-switch");
expect(controls.match(/row\.appendChild\(disclosureText\(disclosure\)\)/g)).toHaveLength(2);
```

Assert both consent and device pages import and call `renderDisclosures`.

- [ ] **Step 2: Run the UI test and confirm failure**

Run: `vp test test/ui.test.ts`

Expected: failure because switch construction and the old renderer name remain.

- [ ] **Step 3: Render all disclosures as identical rows**

Implement the profile loop as:

```ts
for (const scope of scopes.filter((value) => value !== "openid")) {
  const disclosure = profileDisclosures[scope];
  if (!disclosure) {
    throw new Error("This request contains an unsupported claim.");
  }

  const row = document.createElement("div");
  row.appendChild(disclosureText(disclosure));
  container.appendChild(row);
}
```

Rename imports and calls on both pages. Remove `.disclosure-choice`, `.disclosure-switch`, and `.disclosure-copy` CSS while retaining the shared `.disclosure-list > div` grid and mobile collapse.

- [ ] **Step 4: Verify and push the focused commit**

Run: `vp test test/ui.test.ts`

Expected: all UI tests pass.

Commit and push:

```bash
git add src/scripts/disclosure-controls.ts src/pages/consent.astro src/pages/device/verify.astro src/styles/global.css test/ui.test.ts
git commit -m "fix: present requested claims as facts"
git push origin main
```

### Task 3: Landing privacy and scope contract

**Files:**

- Modify: `test/ui.test.ts`
- Modify: `src/pages/index.astro`
- Modify: `src/styles/global.css`

**Interfaces:**

- Produces: a static `privacy-scopes` landing section using existing section-heading and ledger conventions.

- [ ] **Step 1: Write the failing landing contract test**

Assert the page contains:

```ts
expect(landing).toContain("ASK FOR LESS.");
expect(landing).toContain("REVEAL LESS.");
expect(landing).toContain("IDENTITY ONLY");
expect(landing).toContain(
  "No raw provider ID, email, handle, name, avatar, or provider access token.",
);
expect(landing).toContain("email");
expect(landing).toContain("handle");
expect(landing).toContain("avatar");
```

- [ ] **Step 2: Run the UI test and confirm failure**

Run: `vp test test/ui.test.ts`

Expected: failure because the privacy section is absent.

- [ ] **Step 3: Add the editorial privacy section**

Insert the section after `.identity-model` and before `.provider-band`. Use one heading and a bordered ledger with an accent default row plus explicit optional scope rows. Update landing examples from `acct_` and `ps_` to `acc_` and `pws_`.

Extend the existing `.identity-model`, `.quickstart`, and `.device-callout` spacing rule to `.privacy-scopes`. Reuse claim-ledger typography where possible; add only classes required to distinguish withheld/default and optional-scope evidence.

- [ ] **Step 4: Verify and push the focused commit**

Run: `vp test test/ui.test.ts`

Expected: all UI tests pass.

Commit and push:

```bash
git add src/pages/index.astro src/styles/global.css test/ui.test.ts
git commit -m "feat: explain privacy scope defaults"
git push origin main
```

### Task 4: Callback result hierarchy and sign-out

**Files:**

- Modify: `test/ui.test.ts`
- Modify: `src/pages/demo/callback.astro`
- Modify: `src/styles/global.css`

**Interfaces:**

- Consumes: `GET /api/me` returning `csrf_token` and `POST /session/logout` accepting it.
- Produces: `logoutAccount(): Promise<void>` in the callback browser script.

- [ ] **Step 1: Write failing callback structure tests**

Assert:

```ts
expect(callback).toContain("CHECKING<br /><span>SIGNED RESULT.</span>");
expect(callback).toContain('id="callback-followup"');
expect(callback).toContain('id="callback-logout"');
expect(callback).toContain('fetch("/api/me")');
expect(callback).toContain('fetch("/session/logout"');
expect(callback.indexOf('class="verified-result"')).toBeLessThan(
  callback.indexOf('id="callback-followup"'),
);
```

Assert CSS gives `.verified-profile dt` the same signal color and font size as `.verified-claims dt`.

- [ ] **Step 2: Run the UI test and confirm failure**

Run: `vp test test/ui.test.ts`

Expected: failure for the old heading, enclosed metadata/actions, muted profile labels, and missing sign-out.

- [ ] **Step 3: Recompose result markup and styles**

Close `.verified-result` after `.verified-profile`. Add a sibling follow-up section containing `.verified-meta` and an `.actions` group with `RUN ANOTHER FLOW` and a danger `SIGN OUT` button. Style profile rows with the exact grid, padding, border, label, value, and wrapping rules used by identity rows.

- [ ] **Step 4: Implement CSRF-protected sign-out states**

Use the existing endpoint contract:

```ts
async function logoutAccount() {
  logout.disabled = true;
  logout.textContent = "SIGNING OUT";

  try {
    const account = await fetch("/api/me");
    const body = (await account.json()) as { csrf_token?: string };
    if (!account.ok || !body.csrf_token) {
      throw new Error("Broker session unavailable.");
    }

    const response = await fetch("/session/logout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: body.csrf_token }),
    });
    if (!response.ok) {
      throw new Error("Sign out failed.");
    }

    location.assign("/demo/");
  } catch {
    logout.disabled = false;
    logout.textContent = "RETRY SIGN OUT";
    logoutStatus.hidden = false;
  }
}
```

Keep sign-out failure text in a dedicated `role="alert"` element outside the verified claims.

- [ ] **Step 5: Verify and push the focused commit**

Run: `vp test test/ui.test.ts test/account.test.ts`

Expected: all selected tests pass.

Commit and push:

```bash
git add src/pages/demo/callback.astro src/styles/global.css test/ui.test.ts
git commit -m "feat: clarify verified callback result"
git push origin main
```

### Task 5: Full verification and production release

**Files:**

- Modify only files required to fix failures found by full verification.

**Interfaces:**

- Produces: remote migration `0003_reset_subject_formats.sql` applied before code deployment.
- Produces: a new Cloudflare Worker version serving the complete change set.

- [ ] **Step 1: Run fresh complete verification**

Run sequentially:

```bash
vp test
vp run check
vp run build
```

Expected: 254 or more tests pass, checks report no formatting/lint/type errors, Wrangler dry-run succeeds, and six Astro pages build.

- [ ] **Step 2: Review repository state**

Run `git status --short --branch`, `git diff`, and `git log --oneline -10`. Do not alter the unrelated user-owned `PRODUCT.md` modification.

- [ ] **Step 3: Apply migration and deploy**

Run:

```bash
vp run db:remote
vp run deploy
```

Expected: migration `0003_reset_subject_formats.sql` applies successfully before Wrangler publishes a new Worker version.

- [ ] **Step 4: Smoke-test production**

Fetch and verify:

```text
/
/.well-known/openid-configuration
/.well-known/jwks.json
/api/providers
/me/
```

Expected: landing includes the privacy section and new prefixes; discovery and JWKS return valid JSON; providers list Google and GitHub; account page starts signed out after the reset.

- [ ] **Step 5: Record final state**

Report the pushed commit hashes, applied migration, deployed Worker version, verification counts, live smoke results, and that the user previously completed the live Google authorization-code flow.
