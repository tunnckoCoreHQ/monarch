# Triad Multi-Provider Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google and Twitter to Triad, replace raw provider IDs with stable opaque global identifiers, reduce ID-token lifetime to five minutes, and make the product UI provider-neutral.

**Architecture:** Provider-specific OAuth details stay in `src/providers.ts` behind provider-aware start/finish interfaces. Routes persist the chosen provider and provider-specific nonce or verifier, while shared token issuance derives both opaque global and pairwise subjects from the existing secret. Static pages discover enabled providers from a small Worker endpoint.

**Tech Stack:** pnpm 11, TypeScript 7, Astro 7, Hono 4, JOSE 6, Vitest 3, Cloudflare Workers, D1, Wrangler 4.

## Global Constraints

- Canonical provider names are exactly `google`, `github`, and `twitter`; never use `x` as an internal value, route label, or identifier prefix.
- `provider_sub` format is `prv_<provider>_<22 base64url characters>` derived with keyed HMAC and is stable across downstream clients.
- Raw provider IDs remain internal to `identities` and never appear in tokens, UI, URLs, or logs.
- Standard `sub` remains equal to client-scoped `pairwise_sub`; `account_sub` remains broker-global without inferred cross-provider linking.
- ID tokens and token response `expires_in` values are exactly 300 seconds; device-code lifetime remains 600 seconds.
- Google requests only `openid`; GitHub requests no profile scope; Twitter requests only scopes required for `/2/users/me`.
- Missing provider credentials exclude that provider from `/api/providers` and reject transactional starts before state creation.
- Default scope is `openid`; optional mandatory request scopes are exactly `email`, `handle`, `name`, and `avatar`.
- Requested profile scopes are all-or-nothing at consent and map to standard JWT claims; no unrequested profile claim may be fetched, stored, or emitted.
- Transient profile claims are AES-GCM encrypted in D1 and bound to their grant hash; consents persist only scope names.
- Product-level UI and copy describe Triad, not a GitHub broker; provider names appear only for support, selection, consent, and setup.
- Preserve the existing near-black/olive, square-rule switchboard visual system and accessibility behavior.
- Never commit or print client secrets.

---

### Task 1: Opaque Provider Subjects And Five-Minute Tokens

**Files:**

- Modify: `src/types.ts`
- Modify: `src/crypto.ts`
- Modify: `src/tokens.ts`
- Modify: `src/routes/oauth.ts`
- Modify: `test/identity.test.ts`
- Modify: `test/tokens.test.ts`
- Modify: `test/oauth.test.ts`

**Interfaces:**

- Produces: `ProviderName = "google" | "github" | "twitter"`.
- Produces: `providerSubject(secret: string, provider: ProviderName, providerUserId: string): Promise<string>`.
- Preserves: `issueIdToken(env, clientId, accountId, providerSub)` with five-minute expiry.

- [ ] **Step 1: Write failing provider-subject and expiry tests**

```ts
it("derives stable separated opaque provider subjects", async () => {
  const secret = "s".repeat(32);
  const github = await providerSubject(secret, "github", "277398031");
  expect(github).toMatch(/^prv_github_[A-Za-z0-9_-]{22}$/);
  expect(await providerSubject(secret, "github", "277398031")).toBe(github);
  expect(await providerSubject(secret, "google", "277398031")).not.toBe(github);
  expect(github).not.toContain("277398031");
});

it("issues a five minute ID token", async () => {
  const { payload } = await verifyIssuedToken();
  expect(payload.exp! - payload.iat!).toBe(300);
});
```

Add route assertions that both authorization-code and device token responses return `expires_in: 300`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run test/identity.test.ts test/tokens.test.ts test/oauth.test.ts`
Expected: FAIL because `providerSubject` is absent and token lifetime is 600 seconds.

- [ ] **Step 3: Implement keyed global provider subjects and five-minute expiry**

```ts
export async function providerSubject(
  secret: string,
  provider: ProviderName,
  providerUserId: string,
): Promise<string> {
  const digest = await hmacSha256(secret, `provider-sub\0${provider}:${providerUserId}`);
  return `prv_${provider}_${digest.slice(0, 22)}`;
}
```

Derive this value immediately after resolving the raw upstream identity. Set JOSE expiry to `"5m"` and token responses to 300. Do not change device grant expiry.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm vitest run test/identity.test.ts test/tokens.test.ts test/oauth.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/crypto.ts src/tokens.ts src/routes/oauth.ts test/identity.test.ts test/tokens.test.ts test/oauth.test.ts
git commit -m "feat: obscure global provider identities"
```

### Task 2: Google, GitHub, And Twitter Provider Adapters

**Files:**

- Modify: `src/types.ts`
- Replace: `src/providers.ts`
- Modify: `src/routes/oauth.ts`
- Modify: `src/routes/device.ts`
- Modify: `src/routes/account.ts`
- Modify: `test/providers.test.ts`

**Interfaces:**

- Produces: `enabledProviders(env: Env): ProviderName[]`.
- Produces: `startProvider(provider, env, state): Promise<{ url: string; verifier?: string; nonce?: string }>`.
- Produces: `finishProvider(provider, env, code, verifier?, nonce?): Promise<ProviderIdentity>`.

- [ ] **Step 1: Write failing adapter tests**

```ts
it("lists only fully configured providers", () => {
  expect(enabledProviders(env({ GOOGLE_CLIENT_SECRET: "" }))).toEqual(["github", "twitter"]);
});

it("starts Google with openid and nonce", async () => {
  const start = await startProvider("google", env(), "state");
  const url = new URL(start.url);
  expect(url.hostname).toBe("accounts.google.com");
  expect(url.searchParams.get("scope")).toBe("openid");
  expect(start.nonce).toHaveLength(43);
});

it("starts Twitter with upstream S256 PKCE", async () => {
  const start = await startProvider("twitter", env(), "state");
  expect(new URL(start.url).pathname).toContain("oauth2/authorize");
  expect(start.verifier).toBeTruthy();
  expect(new URL(start.url).searchParams.get("code_challenge_method")).toBe("S256");
});
```

Mock Google token/JWKS verification, GitHub token/user lookup, and Twitter token/users-me lookup. Assert nonce, issuer, audience, safe immutable IDs, exact callbacks, and no PII scopes.

- [ ] **Step 2: Run provider tests and verify RED**

Run: `pnpm vitest run test/providers.test.ts`
Expected: FAIL because provider-aware interfaces and Env fields do not exist.

- [ ] **Step 3: Implement all adapters**

Add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TWITTER_CLIENT_ID`, and `TWITTER_CLIENT_SECRET` to `Env`. Use Google's remote JWKS and `jwtVerify` with algorithms `RS256`, issuer `https://accounts.google.com` or `accounts.google.com`, configured audience, and stored nonce. Use Twitter callback `/callback/twitter`, upstream PKCE, Basic client authentication, and immutable `data.id`. Keep GitHub behavior unchanged behind the provider-aware interface. Update existing route call sites to pass explicit `"github"` plus stored verifier/nonce so this commit remains type-correct without broadening route acceptance until Task 3.

- [ ] **Step 4: Run provider tests and typecheck**

Run: `pnpm vitest run test/providers.test.ts && pnpm typecheck`
Expected: PASS with no diagnostics.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/providers.ts src/routes/oauth.ts src/routes/device.ts src/routes/account.ts test/providers.test.ts
git commit -m "feat: add Google and Twitter adapters"
```

### Task 3: Privacy Scopes, Provider Claims, And Encrypted Transit

**Files:**

- Create: `src/claims.ts`
- Modify: `src/crypto.ts`
- Modify: `src/providers.ts`
- Modify: `src/tokens.ts`
- Modify: `src/types.ts`
- Create: `test/claims.test.ts`
- Modify: `test/providers.test.ts`
- Modify: `test/tokens.test.ts`

**Interfaces:**

- Produces: `ProfileScope = "email" | "handle" | "name" | "avatar"` and canonical `Scope` lists.
- Produces: `parseScopes(value?: string): Scope[]`, `serializeScopes(scopes): string`, `providerScopes(provider): ProfileScope[]`, and `validateProviderScopes(provider, scopes): void`.
- Produces: `sealClaims(secret, context, claims): Promise<string>` and `openClaims(secret, context, ciphertext): Promise<ProfileClaims>`.
- Changes: provider start/finish accept canonical scopes and finish returns only requested standard claims.
- Changes: `issueIdToken` accepts optional `ProfileClaims` and emits no unrequested fields.

- [ ] **Step 1: Write failing scope, encryption, provider, and token tests**

```ts
it("defaults to identity only and canonicalizes requested scopes", () => {
  expect(parseScopes()).toEqual(["openid"]);
  expect(parseScopes("avatar openid email")).toEqual(["openid", "email", "avatar"]);
  expect(() => parseScopes("email")).toThrow("invalid_scope");
  expect(() => parseScopes("openid phone")).toThrow("invalid_scope");
});

it("enforces provider capabilities", () => {
  expect(() => validateProviderScopes("google", parseScopes("openid handle"))).toThrow(
    "invalid_scope",
  );
  expect(() => validateProviderScopes("twitter", parseScopes("openid email"))).toThrow(
    "invalid_scope",
  );
  expect(() =>
    validateProviderScopes("github", parseScopes("openid email handle name avatar")),
  ).not.toThrow();
});

it("encrypts claims with grant-bound authenticated data", async () => {
  const sealed = await sealClaims("s".repeat(32), "code:abc", {
    email: "user@example.com",
    email_verified: true,
  });
  expect(sealed).not.toContain("user@example.com");
  await expect(openClaims("s".repeat(32), "code:abc", sealed)).resolves.toEqual({
    email: "user@example.com",
    email_verified: true,
  });
  await expect(openClaims("s".repeat(32), "code:other", sealed)).rejects.toThrow();
});
```

Provider tests assert Google requests only mapped `email`/`profile`, GitHub requests `user:email` only for email and chooses verified primary, Twitter requests only mapped user fields, and a missing mandatory account value fails. Token tests assert standard claims appear only when passed.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run test/claims.test.ts test/providers.test.ts test/tokens.test.ts`
Expected: FAIL because claim interfaces, encryption, and scope-aware adapters are absent.

- [ ] **Step 3: Implement canonical mandatory scopes and encrypted claims**

Canonical order is `openid email handle name avatar`. Map scopes to claims:

```ts
export interface ProfileClaims {
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  name?: string;
  picture?: string;
}
```

Derive an AES-256-GCM key from `PAIRWISE_SECRET` using HKDF-SHA256 with salt `triad-auth-claims-v1` and info `claims-encryption`. Use a fresh 12-byte IV and the supplied row context as additional authenticated data. Encode a versioned base64url payload containing IV and ciphertext.

Update adapter scope mapping and reject a successful upstream response missing any mandatory requested claim. Extend `issueIdToken` by spreading only validated profile claims into the signed payload.

- [ ] **Step 4: Run focused/full tests and typecheck**

Run: `pnpm vitest run test/claims.test.ts test/providers.test.ts test/tokens.test.ts && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/claims.ts src/crypto.ts src/providers.ts src/tokens.ts src/types.ts test/claims.test.ts test/providers.test.ts test/tokens.test.ts
git commit -m "feat: add privacy-scoped claims"
```

### Task 4: Persist Provider Choice And Mandatory Scopes Through Flows

**Files:**

- Modify: `src/db.ts`
- Modify: `src/pre-auth.ts`
- Modify: `src/providers.ts`
- Modify: `src/routes/oauth.ts`
- Modify: `src/routes/device.ts`
- Modify: `src/routes/account.ts`
- Modify: `migrations/0001_init.sql`
- Create: `migrations/0002_multi_provider.sql`
- Modify: `test/oauth.test.ts`
- Modify: `test/providers.test.ts`
- Modify: `test/device.test.ts`
- Modify: `test/account.test.ts`
- Modify: `test/d1.ts`

**Interfaces:**

- Produces: GET `/api/providers` returning `{ providers: Array<{ id: ProviderName; scopes: ProfileScope[] }> }`.
- Persists: provider verifier/nonce in `oauth_transactions` and provider in `device_grants`.
- Requires: device verification provider must equal stored grant provider.
- Produces: account API identity values as opaque `provider_sub` values, never raw upstream IDs.
- Persists: canonical requested scopes and grant-bound encrypted profile claims through one-time code and device exchanges.
- Persists: provider on authorization codes and revalidates the client/provider allowlist at redemption.
- Requires: transaction pre-auth cookies use the exact selected provider callback path.
- Requires: a supported but missing mandatory account claim ends as `access_denied`, never `server_error`.

- [ ] **Step 1: Write failing route and migration tests**

```ts
it("returns only configured providers", async () => {
  const response = await app.request("/api/providers", {}, envWithGoogleAndGitHub());
  await expect(response.json()).resolves.toEqual({
    providers: [
      { id: "google", scopes: ["email", "name", "avatar"] },
      { id: "github", scopes: ["email", "handle", "name", "avatar"] },
    ],
  });
});

it("persists the selected Twitter provider on a device grant", async () => {
  const response = await issueDeviceCode("twitter");
  const row = await db.prepare("SELECT provider FROM device_grants").first<{ provider: string }>();
  expect(row?.provider).toBe("twitter");
});

it("returns only requested mandatory claims and scope at token exchange", async () => {
  const token = await completeAuthorization({ scope: "openid email name" });
  expect(token.scope).toBe("openid email name");
  expect(token.claims).toMatchObject({ email: "user@example.com", name: "User" });
  expect(token.claims).not.toHaveProperty("preferred_username");
});
```

Cover unconfigured-provider rejection before inserts, Google nonce persistence, Twitter verifier persistence, callback provider matching, provider-specific pre-auth cookie paths, all three session starts, mandatory-claim `access_denied`, authorization-code provider revalidation, capability metadata, migration allowlists, and a populated `0001` database upgraded through `0002`.

- [ ] **Step 2: Run route suites and verify RED**

Run: `pnpm vitest run test/oauth.test.ts test/device.test.ts test/account.test.ts`
Expected: FAIL on provider selection and missing migration column.

- [ ] **Step 3: Implement provider-aware routes and migration**

Pass provider and canonical scopes into every adapter call. Store `start.verifier`, `start.nonce`, and scopes in transactions and forward them to callback completion. Require `/device/code` provider, store provider and scopes in the grant, return both during inspection, and reject mismatches at verification. Encrypt callback claims with authorization-code hash or device-code hash AAD; decrypt only after atomic grant consumption; return canonical `scope`; and persist only scope names in consent. Add `0002_multi_provider.sql` with required `scopes` and `claims_ciphertext` columns:

```sql
DELETE FROM consent_requests;
DELETE FROM oauth_transactions;
DELETE FROM authorization_codes;
DELETE FROM device_grants;
ALTER TABLE oauth_transactions ADD COLUMN scopes TEXT NOT NULL DEFAULT '["openid"]';
ALTER TABLE authorization_codes ADD COLUMN provider TEXT NOT NULL DEFAULT 'github';
ALTER TABLE authorization_codes ADD COLUMN scopes TEXT NOT NULL DEFAULT '["openid"]';
ALTER TABLE authorization_codes ADD COLUMN claims_ciphertext TEXT;
ALTER TABLE device_grants ADD COLUMN provider TEXT NOT NULL DEFAULT 'github';
ALTER TABLE device_grants ADD COLUMN scopes TEXT NOT NULL DEFAULT '["openid"]';
ALTER TABLE device_grants ADD COLUMN claims_ciphertext TEXT;
UPDATE clients SET providers = '["google","github","twitter"]'
WHERE client_id IN ('triad-demo', 'triad-account');
```

Keep `0001_init.sql` compatible with sequential fresh migration application. Add an upgrade test that applies `0001`, inserts durable account/identity/consent rows plus transient rows, applies `0002`, and proves durable data survives while transient data is cleared. Derive opaque identity values in `/api/me` before returning them.

- [ ] **Step 4: Run route suites, migration, and typecheck**

Run: `pnpm vitest run test/oauth.test.ts test/device.test.ts test/account.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/pre-auth.ts src/providers.ts src/routes migrations test/oauth.test.ts test/providers.test.ts test/device.test.ts test/account.test.ts test/d1.ts
git commit -m "feat: route scoped Triad identities"
```

### Task 5: Provider-Neutral Triad UI And Mandatory Consent

**Files:**

- Modify: `src/components/Shell.astro`
- Modify: `src/pages/index.astro`
- Modify: `src/pages/demo/index.astro`
- Modify: `src/pages/consent.astro`
- Modify: `src/pages/device/verify.astro`
- Modify: `src/pages/me.astro`
- Modify: `src/styles/global.css`
- Modify: `src/scripts/demo-protocol.ts`
- Modify: `PRODUCT.md`
- Modify: `DESIGN.md`
- Modify: `test/ui.test.ts`

**Interfaces:**

- Consumes: `/api/providers` and persisted provider from consent/device inspection.
- Produces: accessible provider/scope request controls in the demo and fixed all-or-nothing disclosure in consent/device verification.

- [ ] **Step 1: Write failing static UI tests**

```ts
it("presents Triad rather than a GitHub-only broker", async () => {
  const landing = await readFile("src/pages/index.astro", "utf8");
  expect(landing).not.toContain("GitHub broker");
  expect(landing).toContain("GOOGLE");
  expect(landing).toContain("GITHUB");
  expect(landing).toContain("TWITTER");
});

it("uses twitter and never x as provider vocabulary", async () => {
  const pages = await readApplicationSources();
  expect(pages).not.toMatch(/provider[=:]["']x["']/i);
  expect(pages).toContain("twitter");
});
```

Assert demo/account fetch `/api/providers`, demo sends selected optional scopes, consent/device render API provider values and every mandatory requested claim without editable claim checkboxes, and no raw `github:<id>` examples remain.

- [ ] **Step 2: Run UI tests and verify RED**

Run: `pnpm vitest run test/ui.test.ts`
Expected: FAIL on GitHub-only copy and controls.

- [ ] **Step 3: Implement neutral copy and provider controls**

Keep the existing design system. Add one square ruled provider selector and client-request scope controls to the demo; scope controls default off and express what the demo client requests, not a user consent subset. Use selected enabled provider and capability data for browser and device requests. Populate account sign-in actions from `/api/providers`. Device inspection returns and locks provider/scopes. Consent lists every requested claim as mandatory and offers one approve or deny action with no editable checkboxes. Replace product copy with provider-neutral language and opaque examples such as `prv_twitter_R4...`.

- [ ] **Step 4: Build and run UI tests**

Run: `pnpm build && pnpm vitest run test/ui.test.ts && pnpm typecheck`
Expected: PASS and CSP hashes regenerate.

- [ ] **Step 5: Commit**

```bash
git add src/components src/pages src/styles src/scripts PRODUCT.md DESIGN.md test/ui.test.ts src/generated/csp-script-hashes.ts
git commit -m "feat: present privacy-first Triad consent"
```

### Task 6: Configuration, Provider Setup Links, Deployment, And Verification

**Files:**

- Modify: `.dev.vars.example`
- Modify: `scripts/check-config.mjs`
- Modify: `wrangler.toml`
- Modify: `README.md`
- Modify: `test/config.test.ts`
- Modify: `docs/validation/visual-check.md`

**Interfaces:**

- Produces: config validation for signing secrets and complete optional provider credential pairs without exposing values.
- Documents: exact Google, GitHub, and Twitter app creation links and callbacks.

- [ ] **Step 1: Write failing config and documentation tests**

```ts
it("rejects a half-configured optional provider without exposing values", async () => {
  const result = runConfigCheck({ ...githubOnlyValues(), GOOGLE_CLIENT_ID: "google-id" });
  expect(result.stderr).toContain("GOOGLE_CLIENT_SECRET");
  expect(result.stderr).not.toContain("google-id");
});

it("documents exact provider setup links", async () => {
  const readme = await readFile("README.md", "utf8");
  expect(readme).toContain("https://console.cloud.google.com/auth/clients");
  expect(readme).toContain("https://developer.x.com/en/portal/dashboard");
  expect(readme).toContain("/callback/twitter");
});
```

- [ ] **Step 2: Run config tests and verify RED**

Run: `pnpm vitest run test/config.test.ts`
Expected: FAIL because new variables and links are absent.

- [ ] **Step 3: Update configuration and docs**

Add empty Google/Twitter fields to `.dev.vars.example`, all four names to Wrangler secret comments, and exact setup links/callbacks to README. Config validation requires signing/pairwise secrets, at least one complete provider pair, and rejects any half-configured provider pair. Explain that provider controls are enabled only after complete credential pairs are uploaded. Keep existing local `.dev.vars` ignored and never stage it.

- [ ] **Step 4: Verify, migrate, deploy, and smoke test**

Run: `pnpm check`
Expected: typecheck, all Vitest tests, Astro build, and Wrangler dry-run PASS.

Run: `pnpm wrangler d1 migrations apply triad-auth --remote && pnpm deploy`
Expected: `0002_multi_provider.sql` applies and the Worker deploys at the existing issuer.

Smoke checks:

```sh
curl --fail "$ISSUER/api/providers"
curl --fail "$ISSUER/.well-known/openid-configuration"
```

Expected before new credentials: `/api/providers` returns `github`; Google and Twitter start routes return unavailable-provider errors without state rows. After credentials are uploaded, each appears and redirects to its correct upstream callback.

- [ ] **Step 5: Commit and push**

```bash
git add .dev.vars.example scripts/check-config.mjs wrangler.toml README.md test/config.test.ts docs/validation/visual-check.md
git commit -m "docs: configure all Triad providers"
git push origin main
```
