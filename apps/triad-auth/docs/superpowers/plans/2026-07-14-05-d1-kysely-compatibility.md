# Better Auth D1 Kysely Compatibility Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Better Auth `1.7.0-rc.1` direct-D1 initialization by resolving its bundled D1 dialect against the compatible Kysely `0.28.17` API.

**Architecture:** Better Auth RC.1's packages accept Kysely 0.28.17 as their lowest common compatible 0.28 release, but `@better-auth/kysely-adapter`'s bundled D1 dialect imports migration constants removed from Kysely's root export in 0.29. Pin the transitive package through the pnpm workspace override to 0.28.17 and protect direct D1 initialization with an executable contract test.

**Tech Stack:** TypeScript 6, Better Auth `1.7.0-rc.1`, Kysely `0.28.17`, pnpm overrides, Vite+ Test

## Global Constraints

- Work on branch `triad-ba-05-d1-kysely-compatibility` in its own worktree from the reviewed CIMD merge.
- Merge only into `triad-better-auth`; never merge into `main`.
- Keep Better Auth and every first-party Better Auth package pinned exactly to `1.7.0-rc.1`.
- Pin Kysely in `pnpm-workspace.yaml`'s existing overrides; pnpm 11 ignores a `package.json#pnpm` settings block. Do not add Kysely as an application dependency.
- Do not patch Better Auth, Kysely, OAuth Provider, or CIMD in this task.
- Preserve both existing pnpm package patches and verify that a frozen install applies them in the feature worktree.
- Do not add application auth configuration, D1 bindings, schema files, routes, providers, or UI behavior.
- Do not touch `vite.config.ts`, `.dev.vars`, visual files, or provider credentials.
- Run `vp run check` and `vp run build` before commit.

---

### Task 1: Reproduce And Fix Direct-D1 Initialization

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Create: `test/better-auth/d1-runtime-contract.test.ts`
- Create: `docs/superpowers/research/2026-07-14-d1-kysely-compatibility.md`

- [ ] **Step 1: Install the reviewed dependency baseline**

Run:

```sh
vp install --frozen-lockfile
vp test test/better-auth/package-baseline.test.ts test/better-auth/subject-hook-contract.test.ts test/better-auth/public-dcr-guard-contract.test.ts test/better-auth/cimd-package-contract.test.ts
```

Expected: frozen install succeeds and all 14 existing package contracts pass. Stop and repair the feature-worktree dependency state if either patch is absent.

- [ ] **Step 2: Write the failing D1 runtime contract**

Create `test/better-auth/d1-runtime-contract.test.ts`. Build the smallest runtime D1-shaped object whose `prepare().bind().all()` returns an empty successful D1 result and whose `batch` and `exec` methods exist. Cast the runtime-shaped statement and database through `unknown` to `D1PreparedStatement` and `D1Database`; the Worker types also require methods that Better Auth's D1 detection and this request never call. Pass the database directly to:

```ts
const auth = betterAuth({
  database,
  baseURL: "http://localhost",
  secret: "test-secret-that-is-at-least-32-characters",
});
```

Call `auth.handler(new Request("http://localhost/api/auth/get-session"))` and assert status `200`, a JSON content type, and a JSON `null` body. Do not import an adapter or test only assignability; this test must trigger Better Auth's lazy runtime initialization and dynamic D1 dialect import. It protects dialect loading, not D1 query execution; the platform plan owns the Wrangler-local query oracle.

- [ ] **Step 3: Verify Kysely 0.29 breaks the executable contract**

Run:

```sh
vp test test/better-auth/d1-runtime-contract.test.ts
```

Expected: FAIL because RC.1's `d1-sqlite-dialect` imports `DEFAULT_MIGRATION_LOCK_TABLE` from the Kysely root, where 0.29.3 no longer exports it.

- [ ] **Step 4: Pin the compatible transitive Kysely version**

Extend the existing override map in `pnpm-workspace.yaml`:

```yaml
overrides:
  kysely: 0.28.17
  vite: "catalog:"
  vitest: "catalog:"
```

Run:

```sh
vp install
vp exec pnpm why kysely
vp exec pnpm config get patchedDependencies
```

Expected: exactly one Kysely version resolves, `0.28.17`, and both existing package patch paths remain registered.

- [ ] **Step 5: Verify direct-D1 initialization**

Run:

```sh
vp test test/better-auth/d1-runtime-contract.test.ts
```

Expected: PASS with the D1-shaped object passed directly to Better Auth.

- [ ] **Step 6: Document the compatibility boundary**

Create `docs/superpowers/research/2026-07-14-d1-kysely-compatibility.md` documenting the RC.1 import, the Kysely 0.29 export change, the verified 0.28.17 resolution, and the requirement to retest/remove the override when upgrading Better Auth.

- [ ] **Step 7: Verify the full compatibility baseline**

Run:

```sh
vp install --frozen-lockfile
vp test test/better-auth/package-baseline.test.ts test/better-auth/subject-hook-contract.test.ts test/better-auth/public-dcr-guard-contract.test.ts test/better-auth/cimd-package-contract.test.ts test/better-auth/d1-runtime-contract.test.ts
vp run check
vp run build
git diff --check
```

Expected: all package/runtime contracts, checks, and build pass. `vite.config.ts` remains unchanged.

- [ ] **Step 8: Commit the compatibility pin**

Run:

```sh
git add pnpm-workspace.yaml pnpm-lock.yaml test/better-auth/d1-runtime-contract.test.ts docs/superpowers/research/2026-07-14-d1-kysely-compatibility.md
git commit -m "fix: restore better auth d1 compatibility"
```

Expected: one compatibility commit with no application behavior.
