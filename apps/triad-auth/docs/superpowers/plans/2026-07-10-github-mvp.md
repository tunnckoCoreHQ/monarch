# Triad GitHub MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public GitHub-only OAuth/OIDC broker and built-in demo that prove authorization-code/PKCE and device flows while issuing pairwise, provider-global, and broker-global identities.

**Architecture:** A single Hono Cloudflare Worker serves protocol routes and Astro assets, with D1 as the transactional store. Small protocol, security, provider, and token modules keep the route composition testable; the same-origin demo is the only registered downstream client.

**Tech Stack:** pnpm 11, TypeScript 7, Astro 7, Hono 4, JOSE 6, Vitest 3, Cloudflare Workers, D1, Wrangler 4, agent-browser visual validation.

## Global Constraints

- GitHub is the only upstream provider in runtime code, UI, docs, and configuration.
- Standard `sub` and explicit `pairwise_sub` are the same client-scoped HMAC identifier.
- `provider_sub` is the stable namespaced `github:<numeric-id>`; `account_sub` is Triad's random broker-global identifier.
- No email, login, name, avatar, or GitHub access token is persisted or emitted.
- The only downstream client is exact-redirect-allowlisted `triad-demo`.
- Browser mutations are CSRF-protected POST requests; OAuth artifacts are one-time and expire.
- Secrets live only in ignored `.dev.vars` locally and Worker secret storage remotely.
- Do not add Playwright, Puppeteer, Chrome scripts, or another browser automation dependency; use agent-browser.
- Preserve the existing near-black, olive-signal, square-panel Triad visual language and WCAG 2.2 AA behavior.

---

## File Map

- `src/index.ts`: compose middleware and route modules; no provider-specific logic.
- `src/routes/oauth.ts`: discovery, JWKS, authorize, callback, and token routes.
- `src/routes/device.ts`: device issuance, inspection, confirmation, and polling behavior.
- `src/routes/account.ts`: broker session, account data, revocation, and logout.
- `src/security.ts`: headers, no-store responses, CSRF, origin checks, and input bounds.
- `src/protocol.ts`: PKCE and OAuth parameter validation.
- `src/providers.ts`: GitHub authorization, token exchange, and immutable user ID lookup only.
- `src/tokens.ts`: ES256 import/export, pairwise-subject token issuance, and token verification support.
- `src/db.ts`: typed client, transaction, identity, and one-time-consumption helpers.
- `src/types.ts`: Worker bindings and row/domain types.
- `src/pages/demo/index.astro`: starts browser PKCE and device demonstrations.
- `src/pages/demo/callback.astro`: validates browser state, exchanges code, verifies and renders claims.
- `src/pages/consent.astro`, `src/pages/device/verify.astro`, `src/pages/me.astro`: safe transactional UI.
- `migrations/0001_init.sql`: clean GitHub-only production schema and built-in clients.
- `test/*.test.ts`: focused unit and Worker route tests.
- `wrangler.toml`, `.dev.vars.example`, `README.md`: deployable configuration and exact operator instructions.

### Task 1: Establish GitHub-Only Protocol Types And Validation

**Files:**

- Modify: `src/types.ts`
- Create: `src/protocol.ts`
- Modify: `src/db.ts`
- Replace: `test/identity.test.ts`
- Create: `test/protocol.test.ts`

**Interfaces:**

- Produces: `ProviderName = "github"`.
- Produces: `validatePkceChallenge(value: string): boolean`, `validatePkceVerifier(value: string): boolean`, and `parseScope(value?: string): "openid"`.
- Produces: `validateClient(client, redirectUri, provider)` with exact allowlist behavior.

- [ ] **Step 1: Write failing identity and protocol tests**

```ts
import { describe, expect, it } from "vitest";
import { pairwiseSubject } from "../src/crypto";
import { parseScope, validatePkceChallenge, validatePkceVerifier } from "../src/protocol";

describe("identity contract", () => {
  it("keeps pairwise IDs stable within and distinct across clients", async () => {
    const first = await pairwiseSubject("a sufficiently long test secret", "acct_a", "client_a");
    expect(await pairwiseSubject("a sufficiently long test secret", "acct_a", "client_a")).toBe(
      first,
    );
    expect(await pairwiseSubject("a sufficiently long test secret", "acct_a", "client_b")).not.toBe(
      first,
    );
  });
});

describe("protocol validation", () => {
  it("accepts only RFC 7636-sized URL-safe PKCE values", () => {
    expect(validatePkceChallenge("a".repeat(43))).toBe(true);
    expect(validatePkceChallenge("a".repeat(42))).toBe(false);
    expect(validatePkceVerifier("A-._~".repeat(9))).toBe(true);
    expect(validatePkceVerifier("spaces are rejected".repeat(3))).toBe(false);
  });
  it("supports only openid scope", () => {
    expect(parseScope(undefined)).toBe("openid");
    expect(() => parseScope("openid email")).toThrow("unsupported_scope");
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `pnpm install && pnpm vitest run test/identity.test.ts test/protocol.test.ts`
Expected: FAIL because `src/protocol.ts` does not exist.

- [ ] **Step 3: Implement strict GitHub-only types and protocol helpers**

```ts
const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

export const validatePkceVerifier = (value: string) => PKCE.test(value);
export const validatePkceChallenge = (value: string) => CHALLENGE.test(value);

export function parseScope(value?: string): "openid" {
  if (!value || value === "openid") return "openid";
  throw new Error("unsupported_scope");
}
```

Change `ProviderName` to `"github"`; reject malformed JSON arrays in `validateClient`, require `provider === "github"`, and keep exact string comparison for redirect URIs.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run test/identity.test.ts test/protocol.test.ts && pnpm typecheck`
Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/protocol.ts src/db.ts test/identity.test.ts test/protocol.test.ts pnpm-lock.yaml
git commit -m "refactor: narrow broker protocol to GitHub"
```

### Task 2: Correct Token Identity Semantics

**Files:**

- Modify: `src/tokens.ts`
- Create: `test/tokens.test.ts`
- Modify: `src/crypto.ts`

**Interfaces:**

- Produces: `issueIdToken(env, clientId, accountId, providerSub): Promise<string>` where `sub === pairwise_sub`.
- Produces: `publicJwk(env): Promise<Record<string, unknown>>` without private key material.

- [ ] **Step 1: Write a failing signed-claims test**

```ts
import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import { expect, it } from "vitest";
import { issueIdToken, publicJwk } from "../src/tokens";

it("issues a pairwise standard subject plus explicit global subjects", async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), kid: "test" };
  const env = {
    ISSUER: "https://issuer.example",
    PAIRWISE_SECRET: "s".repeat(32),
    SIGNING_PRIVATE_JWK: JSON.stringify(jwk),
  } as never;
  const token = await issueIdToken(env, "triad-demo", "acct_123", "github:42");
  const key = await crypto.subtle.importKey(
    "jwk",
    await publicJwk(env),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const { payload } = await jwtVerify(token, key, { issuer: env.ISSUER, audience: "triad-demo" });
  expect(payload.sub).toBe(payload.pairwise_sub);
  expect(payload.provider_sub).toBe("github:42");
  expect(payload.account_sub).toBe("acct_123");
  expect(payload.sub).not.toBe(payload.provider_sub);
});
```

- [ ] **Step 2: Run the token test and confirm the old global `sub` fails**

Run: `pnpm vitest run test/tokens.test.ts`
Expected: FAIL because current `sub` equals `provider_sub`.

- [ ] **Step 3: Set the JWT subject to the derived pairwise value**

```ts
const pairwiseSub = await pairwiseSubject(env.PAIRWISE_SECRET, accountId, clientId);
return new SignJWT({ provider_sub: providerSub, account_sub: accountId, pairwise_sub: pairwiseSub })
  .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: privateJwk.kid ?? "main" })
  .setIssuer(env.ISSUER)
  .setAudience(clientId)
  .setSubject(pairwiseSub)
  .setIssuedAt()
  .setExpirationTime("10m")
  .setJti(crypto.randomUUID())
  .sign(key);
```

Validate that `PAIRWISE_SECRET` is at least 32 characters before deriving a subject, and throw a configuration error otherwise.

- [ ] **Step 4: Run token and identity tests**

Run: `pnpm vitest run test/tokens.test.ts test/identity.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tokens.ts src/crypto.ts test/tokens.test.ts
git commit -m "fix: make OIDC subject pairwise"
```

### Task 3: Add Browser And Response Safety Primitives

**Files:**

- Create: `src/security.ts`
- Create: `test/security.test.ts`
- Modify: `src/types.ts`
- Modify: `migrations/0001_init.sql`

**Interfaces:**

- Produces: `securityHeaders(): MiddlewareHandler`.
- Produces: `assertSameOrigin(request, issuer): void`.
- Produces: `createCsrfToken(db, purpose): Promise<string>` and `consumeCsrfToken(db, token, purpose): Promise<boolean>`.
- Produces: `noStore(response): Response`.

- [ ] **Step 1: Write failing header, origin, and one-time CSRF tests**

```ts
import { expect, it } from "vitest";
import { assertSameOrigin } from "../src/security";

it("accepts the canonical origin and rejects cross-origin mutation", () => {
  expect(() =>
    assertSameOrigin(
      new Request("https://auth.example/api", {
        method: "POST",
        headers: { origin: "https://auth.example" },
      }),
      "https://auth.example",
    ),
  ).not.toThrow();
  expect(() =>
    assertSameOrigin(
      new Request("https://auth.example/api", {
        method: "POST",
        headers: { origin: "https://evil.example" },
      }),
      "https://auth.example",
    ),
  ).toThrow("invalid_origin");
});
```

Add a D1 fake test that creates a token, consumes it once successfully, and receives `false` on the second consumption.

- [ ] **Step 2: Run the security test and confirm failure**

Run: `pnpm vitest run test/security.test.ts`
Expected: FAIL because `src/security.ts` does not exist.

- [ ] **Step 3: Implement safety primitives and CSRF storage**

```ts
export function assertSameOrigin(request: Request, issuer: string): void {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(issuer).origin) throw new Error("invalid_origin");
}

export function noStore(response: Response): Response {
  const next = new Response(response.body, response);
  next.headers.set("cache-control", "no-store");
  next.headers.set("pragma", "no-cache");
  return next;
}
```

The middleware sets CSP restricted to self plus required inline Astro styles/scripts by hash or nonce, `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a restrictive `Permissions-Policy`. Add `csrf_tokens(token_hash, purpose, expires_at, created_at)` to the migration and atomically delete tokens on consumption.

- [ ] **Step 4: Run security tests and migration locally**

Run: `pnpm vitest run test/security.test.ts && pnpm db:local`
Expected: PASS and migration applies cleanly to local D1.

- [ ] **Step 5: Commit**

```bash
git add src/security.ts src/types.ts migrations/0001_init.sql test/security.test.ts
git commit -m "feat: add browser request safety"
```

### Task 4: Implement And Test The GitHub Authorization-Code Flow

**Files:**

- Modify: `src/providers.ts`
- Create: `src/routes/oauth.ts`
- Modify: `src/db.ts`
- Modify: `src/index.ts`
- Create: `test/providers.test.ts`
- Create: `test/oauth.test.ts`

**Interfaces:**

- Consumes: strict PKCE, CSRF, token, and D1 helpers from Tasks 1-3.
- Produces: `oauthRoutes: Hono<{ Bindings: Env }>` mounted by `src/index.ts`.
- Produces: `startProvider(env, state): { url: string }` and `finishProvider(env, code): ProviderIdentity`.

- [ ] **Step 1: Write failing provider and route tests**

```ts
it("requests only GitHub identity and returns the immutable numeric id", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "temporary" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 42, login: "mutable-name" }), { status: 200 }),
      ),
  );
  await expect(finishProvider(env, "code")).resolves.toEqual({ provider: "github", id: "42" });
});
```

Route tests must assert invalid clients never redirect, malformed PKCE is rejected, consent approval requires origin plus CSRF, callback state is one-time, token exchange requires the verifier, and replay returns `invalid_grant`.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pnpm vitest run test/providers.test.ts test/oauth.test.ts`
Expected: FAIL because routes and GitHub-only signatures are absent.

- [ ] **Step 3: Implement GitHub-only provider and OAuth routes**

Use GitHub endpoints `https://github.com/login/oauth/authorize`, `https://github.com/login/oauth/access_token`, and `https://api.github.com/user`. Request no profile scopes, send `Accept: application/json`, require a safe integer `id`, convert it to decimal text, and let the access-token variable fall out of scope immediately after lookup.

The authorization route validates all parameters before storing a hashed ticket. Consent data includes a one-time CSRF token. The callback consumes state before upstream exchange. Token exchange atomically marks a code consumed before signing the ID token.

- [ ] **Step 4: Run route tests and full typecheck**

Run: `pnpm vitest run test/providers.test.ts test/oauth.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers.ts src/routes/oauth.ts src/db.ts src/index.ts test/providers.test.ts test/oauth.test.ts
git commit -m "feat: complete GitHub authorization flow"
```

### Task 5: Implement And Test The Device Flow

**Files:**

- Create: `src/routes/device.ts`
- Modify: `src/index.ts`
- Modify: `src/db.ts`
- Create: `test/device.test.ts`

**Interfaces:**

- Produces: `deviceRoutes: Hono<{ Bindings: Env }>` mounted by `src/index.ts`.
- Produces RFC-shaped `device_code`, `user_code`, verification URI, expiry, interval, and polling errors.

- [ ] **Step 1: Write failing device-state tests**

```ts
it.each([
  ["pending", "authorization_pending"],
  ["denied", "access_denied"],
])("returns %s as %s", async (status, expected) => {
  await seedGrant({ status });
  const response = await app.request("/token", tokenRequest());
  await expect(response.json()).resolves.toMatchObject({ error: expected });
});
```

Also test invalid client, normalized code, expiry, interval slowdown, CSRF-protected confirmation, atomic callback approval, and one-time token exchange.

- [ ] **Step 2: Run device tests and confirm failure**

Run: `pnpm vitest run test/device.test.ts`
Expected: FAIL because the route module does not exist.

- [ ] **Step 3: Implement the device route module**

Issue 32-byte random device codes stored only by SHA-256 hash and eight-character unambiguous user codes. Return HTTP 400 OAuth JSON errors with `no-store`. Increase polling interval by five seconds after an early poll. Require exact same origin plus a one-time CSRF token before creating the upstream GitHub transaction. Consume approved grants atomically before token issuance.

- [ ] **Step 4: Run device and OAuth suites**

Run: `pnpm vitest run test/device.test.ts test/oauth.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/device.ts src/index.ts src/db.ts test/device.test.ts
git commit -m "feat: complete device authorization flow"
```

### Task 6: Build The Same-Origin Demo And Transactional UI

**Files:**

- Create: `src/pages/demo/index.astro`
- Create: `src/pages/demo/callback.astro`
- Modify: `src/pages/consent.astro`
- Modify: `src/pages/device/verify.astro`
- Modify: `src/pages/index.astro`
- Modify: `src/styles/global.css`
- Modify: `src/components/Shell.astro`

**Interfaces:**

- Consumes: `triad-demo`, `/authorize`, `/token`, `/device/code`, `/device/verify`, discovery, and JWKS.
- Produces: accessible browser and device demo controls with verified claim rendering.

- [ ] **Step 1: Add a static build assertion that initially fails**

```ts
import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";

it("builds both demo entry points", async () => {
  await expect(readFile("dist/demo/index.html", "utf8")).resolves.toContain("TRY THE BROKER");
  await expect(readFile("dist/demo/callback/index.html", "utf8")).resolves.toContain(
    "VERIFYING IDENTITY",
  );
});
```

- [ ] **Step 2: Run build and assertion to confirm failure**

Run: `pnpm build && pnpm vitest run test/ui.test.ts`
Expected: FAIL because demo pages do not exist.

- [ ] **Step 3: Implement browser PKCE and device demo pages**

Use Web Crypto to generate a 64-byte verifier, SHA-256 URL-safe challenge, and state. Store only verifier/state in `sessionStorage`. On callback, reject state mismatch before exchanging the code. Fetch discovery and JWKS, import the matching ES256 key, verify signature and `iss`/`aud`/`exp` in browser code, and label all three identity claims with clear correlation semantics.

The device demo starts a grant, renders user code and verification link, polls at the server interval, backs off on `slow_down`, and stops on terminal state or expiry. Consent copy states that `provider_sub` is globally correlatable. Device submission includes the fetched CSRF token. Remove every Google/X control and claim from UI.

- [ ] **Step 4: Build and run UI assertions**

Run: `pnpm build && pnpm vitest run test/ui.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages src/styles/global.css src/components/Shell.astro test/ui.test.ts
git commit -m "feat: add interactive broker demos"
```

### Task 7: Finish Session, Account, Logout, And Rate Limits

**Files:**

- Create: `src/routes/account.ts`
- Create: `src/rate-limit.ts`
- Modify: `src/index.ts`
- Modify: `src/pages/me.astro`
- Modify: `migrations/0001_init.sql`
- Create: `test/account.test.ts`
- Create: `test/rate-limit.test.ts`

**Interfaces:**

- Produces: `accountRoutes` with `/session/start`, `/api/me`, consent revocation, and POST `/session/logout`.
- Produces: `enforceRateLimit(db, bucket, key, limit, windowSeconds): Promise<boolean>`.

- [ ] **Step 1: Write failing session and limiter tests**

```ts
it("logs out only through a same-origin CSRF-protected POST", async () => {
  const get = await app.request("/session/logout");
  expect(get.status).toBe(404);
  const crossOrigin = await app.request("/session/logout", {
    method: "POST",
    headers: { origin: "https://evil.example" },
  });
  expect(crossOrigin.status).toBe(403);
});
```

Limiter tests exercise exactly `limit` accepted attempts, one rejection, and acceptance after window expiry.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pnpm vitest run test/account.test.ts test/rate-limit.test.ts`
Expected: FAIL because account routes and limiter are absent.

- [ ] **Step 3: Implement account routes and bounded D1 limiter**

Store only hashed session tokens. Rotate a session after GitHub callback, set `Secure`, `HttpOnly`, `SameSite=Lax`, and 30-day maximum age, and clear both cookie and D1 row on logout. Add a `rate_limits(bucket, key_hash, window_start, count)` table with a composite primary key. Hash CF-Connecting-IP before storage and periodically delete expired buckets. Apply conservative limits to authorization starts, device issuance/inspection, callbacks, and token polling without logging client secrets or OAuth artifacts.

- [ ] **Step 4: Run account, limiter, and full tests**

Run: `pnpm vitest run test/account.test.ts test/rate-limit.test.ts && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/account.ts src/rate-limit.ts src/index.ts src/pages/me.astro migrations/0001_init.sql test/account.test.ts test/rate-limit.test.ts
git commit -m "feat: finish account session safety"
```

### Task 8: Make Configuration And Documentation Deployable

**Files:**

- Modify: `wrangler.toml`
- Modify: `package.json`
- Create: `.dev.vars.example`
- Modify: `.gitignore`
- Replace: `README.md`
- Modify: `PRODUCT.md`
- Modify: `DESIGN.md`
- Create: `scripts/check-config.mjs`

**Interfaces:**

- Produces: `pnpm check:config`, `pnpm check`, and documented deploy commands.
- Requires local `.dev.vars` keys `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SIGNING_PRIVATE_JWK`, and `PAIRWISE_SECRET`.

- [ ] **Step 1: Add a failing configuration check**

```js
const required = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "SIGNING_PRIVATE_JWK",
  "PAIRWISE_SECRET",
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing required configuration: ${missing.join(", ")}`);
  process.exit(1);
}
JSON.parse(process.env.SIGNING_PRIVATE_JWK);
if (process.env.PAIRWISE_SECRET.length < 32)
  throw new Error("PAIRWISE_SECRET must be at least 32 characters");
```

- [ ] **Step 2: Confirm missing local configuration is reported clearly**

Run: `node scripts/check-config.mjs`
Expected: exits 1 and lists the four missing names without printing values.

- [ ] **Step 3: Finalize config and operator documentation**

Use a real D1 binding ID only after creation; keep no `REPLACE_ME` in a deployed commit. Add `.dev.vars.example` with empty values and comments, retaining `.dev.vars` in `.gitignore`. Replace provider lists and callbacks with GitHub-only instructions. Document creating the GitHub OAuth App with callback `<ISSUER>/callback/github`, local setup, secret upload, D1 migration, deployment, built-in demo, identity claims, limitations, and revocation behavior. Add `pnpm check` chaining typecheck, test, build, and Wrangler dry-run.

- [ ] **Step 4: Run docs/config scans and checks**

Run: `rg -n "Google|GITHUB_CLIENT_SECRET=.+|X_CLIENT|REPLACE_ME" --glob '!pnpm-lock.yaml' .`
Expected: no stale provider copy, committed secret values, or placeholders.

Run: `pnpm check`
Expected: all checks pass.

- [ ] **Step 5: Commit**

```bash
git add wrangler.toml package.json pnpm-lock.yaml .dev.vars.example .gitignore README.md PRODUCT.md DESIGN.md scripts/check-config.mjs
git commit -m "docs: make GitHub broker deployable"
```

### Task 9: Visual Validation And Accessibility Corrections

**Files:**

- Modify as findings require: `src/pages/**/*.astro`, `src/styles/global.css`, `src/components/Shell.astro`
- Create: `docs/validation/visual-check.md`

**Interfaces:**

- Consumes: locally running Worker and the agent-browser skill/tooling.
- Produces: recorded routes, viewport sizes, keyboard checks, and corrected UI.

- [ ] **Step 1: Start the full local Worker**

Run: `pnpm db:local && pnpm build && pnpm wrangler dev --local`
Expected: Worker serves static assets and APIs at `http://localhost:8787`.

- [ ] **Step 2: Inspect all public surfaces with agent-browser**

Open `/`, `/demo/`, `/demo/callback/`, `/consent/`, `/device/verify/`, and `/me/` at 1440x900 and 390x844. Capture screenshots, inspect console errors, tab through every control, confirm visible focus, check horizontal overflow, and test reduced-motion rendering.

- [ ] **Step 3: Correct concrete visual and accessibility findings**

Keep square panels, near-black surfaces, oversized Archivo headings, JetBrains Mono protocol data, and olive signal color. Correct only observed clipping, contrast, focus, responsive hierarchy, status semantics, or error-state issues; do not redesign into generic cards or gradients.

- [ ] **Step 4: Re-run browser inspection and automated checks**

Run: `pnpm check`
Expected: PASS, and repeat screenshots show no remaining blocker documented in `docs/validation/visual-check.md`.

- [ ] **Step 5: Commit**

```bash
git add src/pages src/styles/global.css src/components/Shell.astro docs/validation/visual-check.md
git commit -m "fix: validate responsive broker UI"
```

### Task 10: Provision, Deploy, Smoke-Test, And Publish

**Files:**

- Modify: `wrangler.toml` with the provisioned D1 database ID and canonical issuer.
- Modify: `README.md` only if deployed URLs differ from documented derivation.

**Interfaces:**

- Produces: stable public Worker URL and remote D1 schema.
- Requires: user-populated GitHub OAuth credentials in ignored `.dev.vars` or the process environment.

- [ ] **Step 1: Verify local credentials without exposing them**

Run: `set -a && source .dev.vars && set +a && pnpm check:config`
Expected: exits 0 and prints only `Configuration valid`.

- [ ] **Step 2: Verify authenticated Cloudflare account and provision D1**

Run: `pnpm wrangler whoami`
Expected: authenticated account details.

Run: `pnpm wrangler d1 create triad-auth`
Expected: a database UUID; place that exact ID in `wrangler.toml`.

- [ ] **Step 3: Apply schema and upload secrets**

Run: `pnpm wrangler d1 migrations apply triad-auth --remote`
Expected: migration `0001_init.sql` succeeds.

Run: `pnpm wrangler secret bulk .dev.vars`
Expected: all four named secrets upload; output does not print values.

- [ ] **Step 4: Deploy, establish canonical issuer, and redeploy**

Run: `pnpm deploy`
Expected: a stable `https://triad-auth-broker.<subdomain>.workers.dev` URL.

Set `ISSUER` in `wrangler.toml` to that exact origin, register `<ISSUER>/callback/github` in the GitHub OAuth App, then run `pnpm deploy` again.

- [ ] **Step 5: Run public smoke checks**

Run: `curl --fail --silent --show-error "$ISSUER/.well-known/openid-configuration"`
Expected: issuer and all endpoints use the canonical HTTPS origin.

Run: `curl --fail --silent --show-error "$ISSUER/.well-known/jwks.json"`
Expected: one public ES256 JWK with no `d` member.

Run: `curl --fail --silent --show-error --head "$ISSUER/"`
Expected: 200 with CSP, frame, no-sniff, referrer, and permissions headers.

Use agent-browser to complete the GitHub browser PKCE demo and device demo against the public URL; both must render a verified token whose `sub === pairwise_sub`, `provider_sub` begins `github:`, and `account_sub` begins `acct_`.

- [ ] **Step 6: Fall back only if accountless hosting meets persistence requirements**

If authenticated Wrangler fails, inspect current Wrangler accountless deployment capabilities. Continue only when the resulting host is stable and supports D1 plus secret injection. If any requirement is absent, record the exact command/error and do not claim an ephemeral preview as the shipped OAuth issuer.

- [ ] **Step 7: Commit deployment identifiers and push**

```bash
git add wrangler.toml README.md
git commit -m "chore: configure production deployment"
git push origin main
```

Run: `gh --profile olstenlarck repo view olstenlarck/triad-auth --json url,defaultBranchRef`
Expected: repository URL and `main` default branch.

Run: `git status --short --branch`
Expected: clean `main` tracking `origin/main`.
