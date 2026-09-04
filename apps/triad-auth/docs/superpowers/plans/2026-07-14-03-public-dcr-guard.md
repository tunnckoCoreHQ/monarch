# Public DCR Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Better Auth's unauthenticated dynamic registration endpoint accepts only explicitly public clients and can never issue an anonymous client secret.

**Architecture:** Extend the existing OAuth Provider pnpm patch with one guard inside the open-registration branch. Session-backed and initial-access-token-backed registration remain unchanged; detailed Triad metadata normalization belongs to the later public-DCR module.

**Tech Stack:** TypeScript 6, `@better-auth/oauth-provider@1.7.0-rc.1`, pnpm patched dependencies, Vite+ Test

## Global Constraints

- Work on branch `triad-ba-03-public-dcr-guard` in its own worktree from the reviewed subject-hook merge.
- Merge only into `triad-better-auth`; never merge into `main`.
- Modify only the existing `@better-auth/oauth-provider@1.7.0-rc.1` pnpm patch, patch metadata, one focused test, and one research note.
- Anonymous DCR must require explicit `token_endpoint_auth_method: "none"`.
- Anonymous DCR must never issue or persist a client secret.
- Preserve session-backed and initial-access-token-backed confidential registration.
- Preserve the existing anonymous `client_credentials` rejection.
- Do not implement redirect, scope, grant, response, resource, or subject normalization in this patch.
- Do not add dependencies or modify auth configuration, schema, routes, UI, CIMD, device flow, `.dev.vars`, provider credentials, or `vite.config.ts`.
- Run `vp run check` and `vp run build` before commit.

---

### Task 1: Reject Anonymous Confidential Registration

**Files:**

- Modify: `patches/@better-auth__oauth-provider@1.7.0-rc.1.patch`
- Modify: `pnpm-lock.yaml`
- Create: `test/better-auth/public-dcr-guard-contract.test.ts`
- Create: `docs/superpowers/research/2026-07-14-oauth-provider-public-dcr-guard.md`

**Interfaces:**

- Consumes: OAuth Provider's existing `allowUnauthenticatedClientRegistration`, session lookup, and initial-access-token authorization.
- Produces: a package-level invariant that open registration reaches client creation only with `token_endpoint_auth_method: "none"`.

- [ ] **Step 1: Write the failing guard contract**

Create `test/better-auth/public-dcr-guard-contract.test.ts`:

```ts
// @ts-expect-error Node types are intentionally absent from the Worker project.
import { readFileSync } from "node:fs";
import { oauthProvider } from "@better-auth/oauth-provider";
import { describe, expect, it } from "vite-plus/test";

const plugin = oauthProvider({
  allowDynamicClientRegistration: true,
  allowUnauthenticatedClientRegistration: true,
  consentPage: "/consent/",
  loginPage: "/sign-in/",
});

const entryUrl = new URL(import.meta.resolve("@better-auth/oauth-provider"));
const entrySource = readFileSync(entryUrl, "utf8");
const openRegistration = entrySource.match(
  /if \(!session && !isTokenAuthorized\) \{[\s\S]*?\n\t}/,
)?.[0];

describe("OAuth Provider public DCR guard", () => {
  it("keeps open registration explicitly enabled", () => {
    expect(plugin.options.allowUnauthenticatedClientRegistration).toBe(true);
  });

  it("requires anonymous clients to declare the none auth method", () => {
    expect(openRegistration).toContain('body.token_endpoint_auth_method !== "none"');
    expect(openRegistration).toContain(
      'unauthenticated registration requires token_endpoint_auth_method "none"',
    );
  });

  it("retains the anonymous client-credentials rejection", () => {
    expect(openRegistration).toContain('body.grant_types?.includes("client_credentials")');
  });
});
```

- [ ] **Step 2: Verify RC.1 fails the confidential-client guard**

Run:

```sh
vp test test/better-auth/public-dcr-guard-contract.test.ts
```

Expected: FAIL because the open-registration branch rejects `client_credentials` but does not reject confidential authentication methods.

- [ ] **Step 3: Extract the already-patched package**

Run:

```sh
vp exec pnpm patch @better-auth/oauth-provider@1.7.0-rc.1 --edit-dir /tmp/opencode/triad-oauth-provider-public-dcr
```

Expected: the extracted `dist/index.mjs` already contains the reviewed subject-hook patch.

- [ ] **Step 4: Add the open-registration auth-method guard**

In `/tmp/opencode/triad-oauth-provider-public-dcr/dist/index.mjs`, add this guard as the first statement inside `if (!session && !isTokenAuthorized)` in `registerEndpoint`:

```js
if (body.token_endpoint_auth_method !== "none")
  throw new APIError("BAD_REQUEST", {
    error: "invalid_client_metadata",
    error_description: 'unauthenticated registration requires token_endpoint_auth_method "none"',
  });
```

Keep the existing `client_credentials grant requires authenticated registration` guard directly after it.

- [ ] **Step 5: Regenerate and apply the cumulative patch**

Run:

```sh
vp exec pnpm patch-commit /tmp/opencode/triad-oauth-provider-public-dcr
vp install
```

Expected: the existing patch file and patch hash update; no second OAuth Provider patch entry is created.

- [ ] **Step 6: Verify DCR and subject contracts together**

Run:

```sh
vp test test/better-auth/subject-hook-contract.test.ts test/better-auth/public-dcr-guard-contract.test.ts
```

Expected: PASS with 8 tests, proving the cumulative patch retains exact-client subject behavior and adds the public-DCR guard.

- [ ] **Step 7: Document the patch boundary**

Create `docs/superpowers/research/2026-07-14-oauth-provider-public-dcr-guard.md`:

```markdown
# OAuth Provider Public DCR Guard

Open registration in `@better-auth/oauth-provider@1.7.0-rc.1` rejects anonymous `client_credentials` clients but otherwise permits confidential authentication methods and can issue a client secret.

Triad's cumulative pnpm patch requires an unauthenticated registration request to explicitly declare `token_endpoint_auth_method: "none"`. Session-backed and initial-access-token-backed registration keep Better Auth's confidential-client behavior.

Redirect URI, grants, response types, scopes, resources, and pairwise subject normalization remain application policy and are not implemented by this package guard.
```

- [ ] **Step 8: Run complete verification**

Run:

```sh
vp test test/better-auth/package-baseline.test.ts test/better-auth/subject-hook-contract.test.ts test/better-auth/public-dcr-guard-contract.test.ts
vp run check
vp run build
git diff --check
```

Expected: 11 focused tests pass, checks and build pass, and no whitespace errors are reported.

- [ ] **Step 9: Commit the public DCR guard**

Run:

```sh
git add patches/@better-auth__oauth-provider@1.7.0-rc.1.patch pnpm-lock.yaml test/better-auth/public-dcr-guard-contract.test.ts docs/superpowers/research/2026-07-14-oauth-provider-public-dcr-guard.md
git commit -m "fix: restrict open dcr to public clients"
```

Expected: one focused commit with the cumulative patch update, lockfile patch hash, contract test, and research note.
