# Better Auth Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish Triad's direct Cloudflare D1 runtime, composable Better Auth factory, schema-generation command, and Worker request boundary without adding identity or OAuth policy.

**Architecture:** Runtime requests construct Better Auth from the request's real `D1Database` binding and route only the exact Better Auth base path into its handler; all other requests retain the existing Astro/assets behavior. A generation-only empty-schema D1 introspection shim lets Better Auth's Kysely schema compiler emit canonical SQLite SQL without an ORM, local database package, or emulator.

**Tech Stack:** TypeScript 6, Better Auth `1.7.0-rc.1`, Cloudflare Workers/D1, Wrangler, Vite+ Test

## Global Constraints

- Work on branch `triad-ba-06-platform-foundation` in its own worktree from the reviewed D1/Kysely compatibility merge.
- Merge only into `triad-better-auth`; never merge into `main`.
- Use `env.DB` directly as `BetterAuthOptions.database`; do not install or wrap it with Drizzle, Miniflare, a SQLite package, or another application adapter.
- Keep the D1 database and Worker name `triad-better-auth`; never reference the existing production database or Worker.
- Begin with `vp install --frozen-lockfile` and the complete compatibility suite. Stop if the reviewed package patches or direct-D1 runtime contract fail.
- Use an all-zero placeholder D1 UUID until the isolated remote D1 database is created during deployment. The placeholder must make accidental remote deployment fail rather than target another database.
- Keep `/api/auth` as the Better Auth base path and `AUTH_ORIGIN` as the canonical issuer origin.
- Require a valid origin-only `AUTH_ORIGIN` and a `BETTER_AUTH_SECRET` of at least 32 characters before constructing auth. Reject nonempty ambient `BETTER_AUTH_SECRETS` and `BETTER_AUTH_TRUSTED_ORIGINS` values so Better Auth cannot replace the binding-backed secret or append trusted origins.
- Disable email/password authentication, alternate secret arrays, CSRF bypass, and origin-check bypass; trust only `AUTH_ORIGIN` at this layer.
- Preserve exact-path routing: `/api/auth` and descendants go to Better Auth; `/api/authentic` does not.
- Preserve existing `__astro_` handling and the assets fallback.
- The schema-only D1 shim may report an empty SQLite schema for SQL compilation. It must not be exported from runtime modules or execute application queries.
- Add schema generation and local migration commands, but do not generate or commit the final migration before domain plugins are composed.
- Do not implement providers, deterministic identity, OAuth Provider, CIMD configuration, DCR normalization, resources, device flow, consent, or UI integration here.
- Do not touch `vite.config.ts`, `.dev.vars`, visual files, provider credentials, package patches, or package versions/overrides.
- Run `vp run check` and `vp run build` before commit.

---

### Task 1: Verify Prerequisites And Specify The Auth Contract

**Files:**

- Create: `src/better-auth/env.ts`
- Create: `src/better-auth/auth.ts`
- Create: `src/better-auth/configuration.ts`
- Create: `test/better-auth/platform-auth.test.ts`

**Interfaces:**

- Produces: `TriadEnv`, `AUTH_BASE_PATH`, `createTriadConfiguration()`, `createTriadAuthOptions()`, and `createTriadAuth()`.
- Consumes later: identity/provider option fragments and reviewed Better Auth plugins through a typed configuration parameter.

- [ ] **Step 1: Verify the complete compatibility baseline**

Run:

```sh
vp install --frozen-lockfile
vp test test/better-auth/package-baseline.test.ts test/better-auth/subject-hook-contract.test.ts test/better-auth/public-dcr-guard-contract.test.ts test/better-auth/cimd-package-contract.test.ts test/better-auth/d1-runtime-contract.test.ts
```

Expected: the frozen install applies both reviewed package patches and every compatibility test passes. Stop before platform work if this gate fails.

- [ ] **Step 2: Write failing option-contract tests**

Cover these invariants in `test/better-auth/platform-auth.test.ts`:

1. `options.database` is the exact `D1Database` object passed as `env.DB`.
2. `baseURL` is the normalized origin and `basePath` is `/api/auth`.
3. Email/password is disabled and `trustedOrigins` contains only the canonical origin.
4. A supplied plugin tuple and non-fixed Better Auth configuration survive composition.
5. Configuration cannot replace the database, `secret`/`secrets`, base URL, base path, trusted origins, disabled password policy, or the enabled CSRF/origin checks. Test a predeclared variable with forbidden extra properties, not only object-literal excess-property checks. Nonempty ambient `BETTER_AUTH_SECRETS` and `BETTER_AUTH_TRUSTED_ORIGINS` values also fail.
6. Missing/short `BETTER_AUTH_SECRET`, non-HTTP(S) URLs, URLs with credentials/path/query/hash, and non-HTTPS non-local origins fail before auth construction.
7. `http://localhost` and loopback HTTP origins remain valid for local development.
8. An uncalled type-check fixture with a small typed plugin proves `createTriadAuth()` retains the plugin endpoint under `auth.api`; runtime tests call only `createTriadAuthOptions()`.
9. `createTriadConfiguration(env)` is the one canonical application-composition seam used by both runtime and schema entry points.

Use a cast-only D1 fixture. Do not create a fake database implementation in runtime contract tests.

- [ ] **Step 3: Verify the contract fails**

Run:

```sh
vp test test/better-auth/platform-auth.test.ts
```

Expected: FAIL because the platform modules do not exist.

- [ ] **Step 4: Define the complete Worker environment shape**

Create `src/better-auth/env.ts` with:

```ts
export interface TriadEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  AUTH_ORIGIN: string;
  BETTER_AUTH_SECRET: string;
  IDENTIFIER_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  TWITTER_CLIENT_ID: string;
  TWITTER_CLIENT_SECRET: string;
}
```

This defines names only. Do not read, copy, print, or validate provider values in this task.

- [ ] **Step 5: Implement fixed platform options and canonical composition**

Create `src/better-auth/auth.ts` with a generic configuration type that declares `database`, `baseURL`, `basePath`, `secret`, `secrets`, `trustedOrigins`, and `emailAndPassword` as optional `never`. Its nested `advanced` type declares `disableCSRFCheck` and `disableOriginCheck` as optional `never`. Implement:

```ts
export const AUTH_BASE_PATH = "/api/auth";

export function createTriadAuthOptions<const Configuration extends TriadAuthConfiguration>(
  env: TriadEnv,
  configuration?: Configuration,
) {
  // Validate and normalize AUTH_ORIGIN and BETTER_AUTH_SECRET.
  // Spread extension configuration first, then assign every fixed invariant.
}

export function createTriadAuth<const Configuration extends TriadAuthConfiguration>(
  env: TriadEnv,
  configuration?: Configuration,
) {
  return betterAuth(createTriadAuthOptions(env, configuration));
}
```

Destructure and discard every forbidden field before composing options so extra runtime properties cannot survive generic structural typing. The fixed fields are `database`, `baseURL`, `basePath`, `secret`, `trustedOrigins`, `emailAndPassword`, and `advanced.disableCSRFCheck`/`advanced.disableOriginCheck` set to `false`; explicitly set `secrets` to `undefined`. Preserve permitted advanced fields before assigning those booleans. Reject nonempty ambient `BETTER_AUTH_SECRETS` and `BETTER_AUTH_TRUSTED_ORIGINS` values. Keep the return type inferred so later plugin tuples retain their API types.

Create `src/better-auth/configuration.ts` with the currently empty `createTriadConfiguration(env)` composition function. Parallel domain workstreams export fragments; only serial integration adds those fragments here. Both Worker and schema entry points must call this same function.

- [ ] **Step 6: Verify the option contract**

Run:

```sh
vp test test/better-auth/platform-auth.test.ts
vp run check
```

Expected: the runtime assertions and semantic type fixture pass.

---

### Task 2: Route Better Auth Without Disturbing Visual Requests

**Files:**

- Modify: `src/index.ts`
- Create: `test/better-auth/worker-routing.test.ts`

**Interfaces:**

- Consumes: `createTriadConfiguration(env)`, `createTriadAuth(env, configuration)`, and `AUTH_BASE_PATH`.
- Produces: exact auth-path routing while preserving Astro and asset handling.

- [ ] **Step 1: Write failing Worker-boundary tests**

Export a small `isAuthPath(pathname)` predicate and a `createWorker(services)` dependency seam from `src/index.ts`. Include configuration creation and auth creation as injectable services. Test the predicate and invoke the returned Worker's `fetch()` with fake configuration, auth, Astro, and asset services. Prove `/api/auth` and descendants call configuration then auth with that exact configuration and call no other service; `/api/authentic` calls only assets; and `/__astro_...` calls only Astro.

The predicate cases include:

```ts
expect(isAuthPath("/api/auth")).toBe(true);
expect(isAuthPath("/api/auth/session")).toBe(true);
expect(isAuthPath("/api/authentic")).toBe(false);
expect(isAuthPath("/api/auth-example/session")).toBe(false);
expect(isAuthPath("/")).toBe(false);
```

- [ ] **Step 2: Verify the routing test fails**

Run:

```sh
vp test test/better-auth/worker-routing.test.ts
```

Expected: FAIL because `isAuthPath` does not exist.

- [ ] **Step 3: Add the Better Auth request branch**

Replace the local `Env` with `TriadEnv`. The default services call `createTriadConfiguration(env)` and pass it to `createTriadAuth(env, configuration)`. After parsing the URL and before the Astro/assets branches:

```ts
if (isAuthPath(url.pathname)) {
  const configuration = createTriadConfiguration(env);

  return createTriadAuth(env, configuration).handler(request);
}
```

Keep the successful request path flat. Do not add root discovery aliases yet; OAuth Provider integration owns those routes.

- [ ] **Step 4: Verify routing and platform options together**

Run:

```sh
vp test test/better-auth/platform-auth.test.ts test/better-auth/worker-routing.test.ts
```

Expected: PASS.

---

### Task 3: Add Isolated D1 And Schema Tooling

**Files:**

- Modify: `wrangler.toml`
- Modify: `package.json`
- Create: `migrations/.gitkeep`
- Create: `scripts/auth-schema-database.ts`
- Create: `src/better-auth/schema.ts`
- Create: `test/better-auth/schema-tooling.test.ts`
- Create: `docs/superpowers/research/2026-07-14-direct-d1-foundation.md`

**Interfaces:**

- Consumes: the same `createTriadConfiguration()` and `createTriadAuth()` functions used at runtime.
- Produces: `auth:schema` and `db:migrate:local` commands plus an isolated `DB` binding.

- [ ] **Step 1: Write failing tooling contract tests**

Assert that:

1. `wrangler.toml` binds `DB` to database name `triad-better-auth`, migration directory `migrations`, and only the all-zero placeholder database UUID.
2. `package.json` exposes `auth:schema` targeting a temporary generated schema outside `migrations/` and `db:migrate:local` with Wrangler's `--local` flag.
3. No Drizzle, Miniflare, SQLite driver, or old database/Worker name appears in the new tooling.
4. The schema auth entry exports `const auth`, calls the canonical configuration function, and passes that exact result to the runtime factory rather than duplicating Better Auth options.

- [ ] **Step 2: Verify the tooling contract fails**

Run:

```sh
vp test test/better-auth/schema-tooling.test.ts
```

Expected: FAIL because no D1 binding or schema tooling exists.

- [ ] **Step 3: Configure only the replacement D1 binding**

Append to `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "triad-better-auth"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "migrations"
```

Add a short comment that deployment replaces the placeholder with the isolated D1 UUID. Do not create or inspect remote resources in this task.

- [ ] **Step 4: Implement the generation-only empty-schema D1 shape**

Create `scripts/auth-schema-database.ts`. Its exported object must satisfy the D1 methods Better Auth detects (`prepare`, `batch`, and `exec`), while `prepare().bind().all()` returns an empty successful result for schema introspection. Throw from query methods not used by Better Auth's migration compiler so accidental application use fails loudly.

This file is a CLI compilation boundary, not a database emulator. It must not be imported by `src/index.ts`, `src/better-auth/auth.ts`, or any runtime module.

- [ ] **Step 5: Add the shared-factory schema entry**

Create `src/better-auth/schema.ts` with an inert `ASSETS` value so its environment satisfies `TriadEnv`. Call `createTriadConfiguration(schemaEnv)` and pass that exact result to `createTriadAuth()`, with the schema-only database, valid placeholder secrets, and provider-name placeholders. Export the resulting instance as `export const auth` for RC.1 CLI discovery. Domain plugins added during serial integration must be composed through `createTriadConfiguration()` so runtime and generated schema cannot drift.

- [ ] **Step 6: Add schema and local migration scripts**

Add sorted scripts equivalent to:

```json
"auth:schema": "vp exec auth generate --config src/better-auth/schema.ts --output /tmp/triad-better-auth-schema.sql --yes",
"db:migrate:local": "vp exec wrangler d1 migrations apply triad-better-auth --local"
```

Create `migrations/.gitkeep`. Do not add a remote migration command yet.

- [ ] **Step 7: Prove Better Auth can compile SQLite SQL**

Run the pinned CLI with a temporary output outside the repository:

```sh
vp exec auth generate --config src/better-auth/schema.ts --output /tmp/opencode/triad-ba-06-core-schema.sql --yes
```

Expected: success; the generated SQL contains Better Auth core tables such as `user`, `session`, `account`, and `verification`. Do not copy or commit this partial schema.

- [ ] **Step 8: Document the direct-D1 boundary**

Create `docs/superpowers/research/2026-07-14-direct-d1-foundation.md` documenting:

- RC.1 detects D1 by `batch`/`exec`/`prepare` and uses its bundled D1 SQLite dialect.
- Runtime receives the real Worker binding directly.
- The CLI-only object reports an empty schema solely so `auth generate` can compile SQL.
- Wrangler, not Better Auth's `migrate` command, applies generated migrations.
- The all-zero UUID is replaced only after the isolated remote D1 database is created.

- [ ] **Step 9: Verify the tooling contract**

Run:

```sh
vp test test/better-auth/schema-tooling.test.ts
```

Expected: PASS.

---

### Task 4: Verify Real Local D1 And Commit The Foundation

**Files:**

- All files from Tasks 1-3.

- [ ] **Step 1: Run focused and package contract tests**

Run:

```sh
vp test test/better-auth/package-baseline.test.ts test/better-auth/subject-hook-contract.test.ts test/better-auth/public-dcr-guard-contract.test.ts test/better-auth/cimd-package-contract.test.ts test/better-auth/d1-runtime-contract.test.ts test/better-auth/platform-auth.test.ts test/better-auth/worker-routing.test.ts test/better-auth/schema-tooling.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Verify a real Wrangler-local D1 request**

Using only `/tmp/opencode/triad-ba-06-d1` for temporary persistence:

1. Generate the temporary core schema from `src/better-auth/schema.ts`.
2. Apply it with `wrangler d1 execute triad-better-auth --local --file ... --persist-to /tmp/opencode/triad-ba-06-d1`.
3. Run `vp run build` because the assets binding points to ignored `dist`.
4. Start the Worker with `wrangler dev --local`, the same persistence directory, a fixed temporary port, `--var BETTER_AUTH_SECRET:<test-secret>`, and `--var AUTH_ORIGIN:http://127.0.0.1:<port>`.
5. Generate a correctly HMAC-signed nonexistent `better-auth.session_token` cookie with that test secret, request `/api/auth/get-session`, and require status `200` with JSON `null`. This forces Better Auth to query the session table; an absent or unusable D1 schema returns `500`.
6. Use a bounded readiness loop and a cleanup trap so the Worker process stops on success or failure.

Do not add Miniflare or a SQLite package. Do not write local D1 state or generated SQL inside the repository.

- [ ] **Step 3: Run complete repository verification**

Run:

```sh
vp run check
vp run build
git diff --check
```

Expected: checks and build pass with no whitespace errors. `vite.config.ts` remains unchanged.

- [ ] **Step 4: Audit deployment isolation**

Run:

```sh
git diff --name-only
git diff -- wrangler.toml package.json src/index.ts src/better-auth scripts/auth-schema-database.ts migrations test/better-auth docs/superpowers/research
```

Confirm no old Worker name, old D1 database, credential value, generated migration, visual file, or unrelated change is present.

- [ ] **Step 5: Commit the platform foundation**

Run:

```sh
git add package.json wrangler.toml src/index.ts src/better-auth/env.ts src/better-auth/auth.ts src/better-auth/configuration.ts src/better-auth/schema.ts scripts/auth-schema-database.ts migrations/.gitkeep test/better-auth/platform-auth.test.ts test/better-auth/worker-routing.test.ts test/better-auth/schema-tooling.test.ts docs/superpowers/research/2026-07-14-direct-d1-foundation.md
git commit -m "feat: add better auth platform foundation"
```

Expected: one implementation commit limited to the direct-D1 platform boundary.
