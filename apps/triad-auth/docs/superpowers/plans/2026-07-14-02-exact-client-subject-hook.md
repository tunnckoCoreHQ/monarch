# Exact-Client Subject Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one upstream-shaped OAuth Provider hook that derives OIDC-facing subjects from the exact client ID while leaving JWT access-token and introspection subjects global.

**Architecture:** A pnpm patch extends `OAuthOptions` with `resolveSubjectIdentifier`, invokes it only for ID token, UserInfo, and logout subjects, and stops presentation-time pairwise rewriting during introspection. The patch preserves Better Auth's default sector-based behavior when the hook is absent; Triad-specific HMAC logic remains outside the package.

**Tech Stack:** TypeScript 6, `@better-auth/oauth-provider@1.7.0-rc.1`, pnpm patched dependencies, Vite+ Test

## Global Constraints

- Work on branch `triad-ba-02-subject-hook` in its own worktree created from the reviewed package-baseline merge.
- Merge only into `triad-better-auth`; never merge into `main`.
- Patch only `@better-auth/oauth-provider@1.7.0-rc.1`.
- Preserve built-in behavior when `resolveSubjectIdentifier` is absent.
- The hook receives exact `client.clientId`, `userId`, `subjectType`, `use`, and the built-in `defaultSubject`.
- Allowed `use` values are exactly `id_token`, `userinfo`, and `logout_token`.
- JWT access-token `sub` remains Better Auth's global user ID.
- Introspection `sub` remains the global subject stored in the access token; it never invokes the OIDC resolver.
- Do not implement Triad HMAC derivation, claims, DCR, CIMD, device flow, auth configuration, schema, routes, or UI.
- Do not add dependencies.
- Do not touch `vite.config.ts`, `.dev.vars`, visual files, or provider credentials.
- Run `vp run check` and `vp run build` before commit.

---

### Task 1: Patch OAuth Provider Subject Resolution

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Create: `patches/@better-auth__oauth-provider@1.7.0-rc.1.patch`
- Create: `test/better-auth/subject-hook-contract.test.ts`
- Create: `docs/superpowers/research/2026-07-14-oauth-provider-subject-hook.md`

**Interfaces:**

- Consumes: `OAuthOptions`, `oauthProvider`, the package's existing `pairwiseSecret`, and `SchemaClient.clientId`.
- Produces: `OAuthOptions["resolveSubjectIdentifier"]` with the exact callback contract below; default sector behavior remains available through `defaultSubject`.

- [ ] **Step 1: Write the failing public-contract test**

Create `test/better-auth/subject-hook-contract.test.ts`:

```ts
// @ts-expect-error Node types are intentionally absent from the Worker project.
import { readFileSync } from "node:fs";
import { oauthProvider, type OAuthOptions } from "@better-auth/oauth-provider";
import { describe, expect, it } from "vite-plus/test";

const resolver: NonNullable<OAuthOptions["resolveSubjectIdentifier"]> = (input) =>
  `${input.use}:${input.clientId}:${input.userId}:${input.defaultSubject}`;

const plugin = oauthProvider({
  consentPage: "/consent/",
  loginPage: "/sign-in/",
  pairwiseSecret: "subject-hook-contract-secret-32-bytes",
  resolveSubjectIdentifier: resolver,
});

const entryUrl = new URL(import.meta.resolve("@better-auth/oauth-provider"));
const entrySource = readFileSync(entryUrl, "utf8");
const tokenSource = readFileSync(new URL("./introspect-DvHp2a64.mjs", entryUrl), "utf8");
const utilitySource = readFileSync(new URL("./utils-DO8lmoDw.mjs", entryUrl), "utf8");

describe("OAuth Provider exact-client subject hook", () => {
  it("exposes the resolver through the public options type", () => {
    expect(plugin.options.resolveSubjectIdentifier).toBe(resolver);
  });

  it("labels every OIDC-facing subject use", () => {
    expect(entrySource).toContain('resolveSubjectIdentifier(userId, client, opts, "logout_token")');
    expect(tokenSource).toContain('resolveSubjectIdentifier(user.id, client, opts, "userinfo")');
    expect(tokenSource).toContain('resolveSubjectIdentifier(user.id, client, opts, "id_token")');
  });

  it("passes the exact client ID and built-in default subject to the hook", () => {
    expect(utilitySource).toContain("clientId: client.clientId");
    expect(utilitySource).toContain("defaultSubject");
  });

  it("does not pairwise-rewrite introspection subjects", () => {
    const introspectionResolver = tokenSource.match(
      /async function resolveIntrospectionSub[\s\S]*?\n}\nasync function introspectEndpoint/,
    )?.[0];

    expect(introspectionResolver).toContain("return payload;");
    expect(introspectionResolver).not.toContain("resolveSubjectIdentifier(");
  });
});
```

- [ ] **Step 2: Verify the unpatched package fails the contract**

Run:

```sh
vp test test/better-auth/subject-hook-contract.test.ts
```

Expected: FAIL because the installed package source does not label the three OIDC call sites and still pairwise-rewrites introspection.

- [ ] **Step 3: Extract the exact package version for patching**

Run:

```sh
vp exec pnpm patch @better-auth/oauth-provider@1.7.0-rc.1 --edit-dir /tmp/opencode/triad-oauth-provider-subject-hook
```

Expected: pnpm extracts only `@better-auth/oauth-provider@1.7.0-rc.1` into the approved temporary directory.

- [ ] **Step 4: Add the public option type**

In `/tmp/opencode/triad-oauth-provider-subject-hook/dist/oauth-ScTJEcFV.d.mts`, add this property immediately after `pairwiseSecret?: string` in `OAuthOptions`:

```ts
  /**
   * Resolve an OIDC-facing subject after the built-in public or pairwise
   * default has been computed. Access-token and introspection subjects do not
   * use this hook.
   */
  resolveSubjectIdentifier?: (input: {
    userId: string;
    clientId: string;
    subjectType: "public" | "pairwise" | undefined;
    use: "id_token" | "userinfo" | "logout_token";
    defaultSubject: string;
  }) => Awaitable<string>;
```

- [ ] **Step 5: Implement default-preserving resolver dispatch**

In `/tmp/opencode/triad-oauth-provider-subject-hook/dist/utils-DO8lmoDw.mjs`, replace `resolveSubjectIdentifier` with:

```js
async function resolveSubjectIdentifier(userId, client, opts, use) {
  const defaultSubject =
    client.subjectType === "pairwise" && opts.pairwiseSecret
      ? await computePairwiseSub(userId, client, opts.pairwiseSecret)
      : userId;
  if (!opts.resolveSubjectIdentifier) return defaultSubject;
  return opts.resolveSubjectIdentifier({
    userId,
    clientId: client.clientId,
    subjectType: client.subjectType,
    use,
    defaultSubject,
  });
}
```

- [ ] **Step 6: Label the three OIDC call sites**

Apply these exact call changes in the extracted package:

```js
// dist/index.mjs
sub: await resolveSubjectIdentifier(userId, client, opts, "logout_token");

// dist/introspect-DvHp2a64.mjs, UserInfo
baseUserClaims.sub = await resolveSubjectIdentifier(user.id, client, opts, "userinfo");

// dist/introspect-DvHp2a64.mjs, ID token
const resolvedSub = await resolveSubjectIdentifier(user.id, client, opts, "id_token");
```

- [ ] **Step 7: Keep introspection global**

In `/tmp/opencode/triad-oauth-provider-subject-hook/dist/introspect-DvHp2a64.mjs`, replace `resolveIntrospectionSub` with:

```js
async function resolveIntrospectionSub(_ctx, _opts, payload, _introspectingClient) {
  return payload;
}
```

This deliberately preserves the global `sub` already carried by opaque and JWT access-token validation.

- [ ] **Step 8: Commit the pnpm patch metadata**

Run:

```sh
vp exec pnpm patch-commit /tmp/opencode/triad-oauth-provider-subject-hook
```

Expected: pnpm creates `patches/@better-auth__oauth-provider@1.7.0-rc.1.patch`, registers it in `pnpm-workspace.yaml`, and updates only patch metadata in `pnpm-lock.yaml`.

- [ ] **Step 9: Verify the patched public and source contracts**

Run:

```sh
vp install
vp test test/better-auth/subject-hook-contract.test.ts
```

Expected: PASS with 4 tests.

- [ ] **Step 10: Document the verified patch boundary**

Create `docs/superpowers/research/2026-07-14-oauth-provider-subject-hook.md`:

```markdown
# OAuth Provider Exact-Client Subject Hook

`@better-auth/oauth-provider@1.7.0-rc.1` computes pairwise subjects from the first redirect URI host and rewrites introspection subjects at presentation time. Triad requires exact-client OIDC subjects and global access-token/introspection subjects.

The pnpm patch adds `resolveSubjectIdentifier` only after the built-in default is computed. The callback receives `userId`, exact `clientId`, `subjectType`, `defaultSubject`, and one of `id_token`, `userinfo`, or `logout_token`.

Without the callback, Better Auth's built-in subject behavior is unchanged. JWT access-token creation never calls the hook. Introspection returns the global token subject without pairwise rewriting.
```

- [ ] **Step 11: Run complete verification**

Run:

```sh
vp test test/better-auth/package-baseline.test.ts test/better-auth/subject-hook-contract.test.ts
vp run check
vp run build
git diff --check
```

Expected: 7 focused tests pass, checks and build pass, Wrangler dry-run targets `triad-better-auth`, and no whitespace errors are reported.

- [ ] **Step 12: Commit the subject hook**

Run:

```sh
git add pnpm-workspace.yaml pnpm-lock.yaml patches/@better-auth__oauth-provider@1.7.0-rc.1.patch test/better-auth/subject-hook-contract.test.ts docs/superpowers/research/2026-07-14-oauth-provider-subject-hook.md
git commit -m "fix: add exact-client oauth subjects"
```

Expected: one commit limited to the package patch, patch metadata, focused contract test, and research note.
