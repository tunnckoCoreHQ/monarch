# Better Auth Package Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install and verify the exact Better Auth RC.1 package baseline without adding authorization-server behavior.

**Architecture:** This serial prerequisite changes only dependency metadata, one package-contract test, and one immutable API inventory. It proves the package entry points, RC.1 CLI package, and direct Cloudflare `D1Database` type contract that every later worktree consumes.

**Tech Stack:** TypeScript 6, Better Auth `1.7.0-rc.1`, Vite+ Test, Cloudflare Workers types, pnpm 11

## Global Constraints

- Work on branch `triad-ba-01-package-baseline` in its own worktree created from `triad-better-auth` commit `1883e24` or its direct planning-only descendant.
- Merge only into `triad-better-auth`; never merge into `main`.
- Pin `better-auth`, `@better-auth/oauth-provider`, `@better-auth/cimd`, and `auth` to exactly `1.7.0-rc.1` without version ranges.
- Use the `auth` package for the RC.1 CLI; `@better-auth/cli@1.7.0-rc.1` does not exist.
- Pass Cloudflare `D1Database` directly through Better Auth's built-in database option.
- Do not add Drizzle ORM, Drizzle Kit, Kysely adapters, Miniflare, Hono, or another database abstraction.
- Do not add package patches, application auth configuration, migrations, Worker routes, or product changes.
- Do not restore any inherited test.
- Do not inspect, print, rotate, or modify `.dev.vars` or provider credential values.
- Do not touch `vite.config.ts`.
- Use TypeScript 6 and Vite+ commands.
- Run `vp run check` and `vp run build` before commit.

---

### Task 1: Pin And Verify Better Auth RC.1 Packages

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `test/better-auth/package-baseline.test.ts`
- Create: `docs/superpowers/research/2026-07-14-better-auth-rc1-package-baseline.md`

**Interfaces:**

- Consumes: Cloudflare's global `D1Database` type from `@cloudflare/workers-types`.
- Produces: installed public imports `betterAuth`, `jwt`, `oauthProvider`, and `cimd`; CLI binary `auth`; evidence that `D1Database` is accepted by `BetterAuthOptions["database"]`.

- [ ] **Step 1: Write the failing package contract**

Create `test/better-auth/package-baseline.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { cimd } from "@better-auth/cimd";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { jwt } from "better-auth/plugins";
import { describe, expect, it } from "vite-plus/test";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const acceptsD1Database = (database: D1Database): BetterAuthOptions["database"] => database;

describe("Better Auth package baseline", () => {
  it("pins every RC.1 runtime package", () => {
    expect(packageJson.dependencies).toMatchObject({
      "@better-auth/cimd": "1.7.0-rc.1",
      "@better-auth/oauth-provider": "1.7.0-rc.1",
      "better-auth": "1.7.0-rc.1",
    });
    expect(packageJson.devDependencies.auth).toBe("1.7.0-rc.1");
  });

  it("exposes the required public factories", () => {
    expect(betterAuth).toBeTypeOf("function");
    expect(jwt).toBeTypeOf("function");
    expect(oauthProvider).toBeTypeOf("function");
    expect(cimd).toBeTypeOf("function");
  });

  it("accepts the Cloudflare D1 binding without an ORM adapter", () => {
    const database = {} as D1Database;

    expect(acceptsD1Database(database)).toBe(database);
  });
});
```

- [ ] **Step 2: Run the contract and record the expected failure**

Run:

```sh
vp test test/better-auth/package-baseline.test.ts
```

Expected: FAIL because `better-auth`, `@better-auth/oauth-provider`, and `@better-auth/cimd` are not installed.

- [ ] **Step 3: Install only the approved exact packages**

Run:

```sh
vp add --save-exact better-auth@1.7.0-rc.1 @better-auth/oauth-provider@1.7.0-rc.1 @better-auth/cimd@1.7.0-rc.1
vp add --save-dev --save-exact auth@1.7.0-rc.1
```

Confirm `package.json` contains no new dependency except those four packages and their lockfile transitive dependencies.

- [ ] **Step 4: Verify the package and direct-D1 contracts**

Run:

```sh
vp test test/better-auth/package-baseline.test.ts
```

Expected: PASS with 3 tests. If TypeScript rejects `D1Database` for `BetterAuthOptions["database"]`, stop with status `BLOCKED`; do not install an adapter or weaken the test.

- [ ] **Step 5: Record the immutable package inventory**

Create `docs/superpowers/research/2026-07-14-better-auth-rc1-package-baseline.md`:

````markdown
# Better Auth 1.7.0-rc.1 Package Baseline

## Installed Packages

| Package                       | Version      | Role                                                     |
| ----------------------------- | ------------ | -------------------------------------------------------- |
| `better-auth`                 | `1.7.0-rc.1` | Core auth factory, built-in database support, JWT plugin |
| `@better-auth/oauth-provider` | `1.7.0-rc.1` | OAuth/OIDC authorization server                          |
| `@better-auth/cimd`           | `1.7.0-rc.1` | Client ID Metadata Documents                             |
| `auth`                        | `1.7.0-rc.1` | `auth` and `better-auth` schema CLI binaries             |

## Verified Public Imports

```ts
import { cimd } from "@better-auth/cimd";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { jwt } from "better-auth/plugins";
```

`BetterAuthOptions["database"]` accepts the Cloudflare `D1Database` binding directly. Triad does not use Drizzle, a Kysely dialect package, or Miniflare.

## CLI Contract

The RC.1 CLI package is `auth@1.7.0-rc.1`. It exposes both `auth` and `better-auth` binaries. There is no `@better-auth/cli@1.7.0-rc.1` release.

## Scope Boundary

This baseline verifies package availability and public entry points only. It does not assert OAuth Provider option names, CIMD option names, extension APIs, schema contents, or runtime protocol behavior. Those contracts belong to the compatibility-hooks workstream.
````

- [ ] **Step 6: Run complete verification**

Run:

```sh
vp test test/better-auth/package-baseline.test.ts
vp run check
vp run build
git diff --check
```

Expected: 3 focused tests pass, checks pass, the six preserved Astro pages build, Wrangler dry-run targets `triad-better-auth`, and no whitespace errors are reported.

- [ ] **Step 7: Commit the package baseline**

Run:

```sh
git add package.json pnpm-lock.yaml test/better-auth/package-baseline.test.ts docs/superpowers/research/2026-07-14-better-auth-rc1-package-baseline.md
git commit -m "chore: pin better auth package baseline"
```

Expected: one commit containing only the four pinned packages, lockfile changes, package-contract test, and package inventory.
