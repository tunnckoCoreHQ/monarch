# Worker-Safe CIMD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RC.1 CIMD metadata fetching work safely on Cloudflare Workers and require a displayable MCP client name.

**Architecture:** A dedicated pnpm patch changes fetch redirect handling from unsupported `error` mode to `manual` mode with explicit 3xx rejection, and extends the package's public metadata validator with a 1-80 Unicode-code-point `client_name` invariant. Existing URL, authentication-method, timeout, body-limit, and metadata validation remain untouched.

**Tech Stack:** TypeScript 6, `@better-auth/cimd@1.7.0-rc.1`, pnpm patched dependencies, Vite+ Test, Cloudflare Workers

## Global Constraints

- Work on branch `triad-ba-04-worker-safe-cimd` in its own worktree from the reviewed public-DCR merge.
- Merge only into `triad-better-auth`; never merge into `main`.
- Patch only `@better-auth/cimd@1.7.0-rc.1`.
- Use `redirect: "manual"` because Cloudflare Workers does not support `redirect: "error"` for this fetch.
- Reject every HTTP 300-399 metadata response before parsing it.
- Require trimmed `client_name` content between 1 and 80 Unicode code points.
- Preserve RC.1's five-second timeout, 5 KiB streaming body limit, exact client ID, public-address validation, allowed auth methods, public-key checks, and origin-bound field validation.
- Do not add a fetch library, DNS library, ORM, emulator, or other dependency.
- Do not implement Triad's `allowFetch` DNS policy, auth factory, clients, schema, routes, UI, or device flow here.
- Do not touch `vite.config.ts`, `.dev.vars`, visual files, or provider credentials.
- Run `vp run check` and `vp run build` before commit.

---

### Task 1: Patch CIMD Name And Redirect Validation

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Create: `patches/@better-auth__cimd@1.7.0-rc.1.patch`
- Create: `test/better-auth/cimd-package-contract.test.ts`
- Create: `docs/superpowers/research/2026-07-14-worker-safe-cimd-patch.md`

**Interfaces:**

- Consumes: public `validateCimdMetadata()` and RC.1's internal metadata fetch.
- Produces: validation failure for missing/blank/oversized `client_name`; Worker-compatible no-follow redirect rejection.

- [ ] **Step 1: Write the failing package contract**

Create `test/better-auth/cimd-package-contract.test.ts`:

```ts
// @ts-expect-error Node types are intentionally absent from the Worker project.
import { readFileSync } from "node:fs";
import { validateCimdMetadata } from "@better-auth/cimd";
import { describe, expect, it } from "vite-plus/test";

const clientId = "https://client.example/metadata.json";
const validMetadata = {
  client_id: clientId,
  client_name: "Example client",
  redirect_uris: ["https://client.example/callback"],
  token_endpoint_auth_method: "none",
};

const entryUrl = new URL(import.meta.resolve("@better-auth/cimd"));
const source = readFileSync(entryUrl, "utf8");

describe("CIMD package contract", () => {
  it("requires a nonempty client name", () => {
    const { client_name: _name, ...missingName } = validMetadata;

    expect(validateCimdMetadata(clientId, missingName)).toMatchObject({ valid: false });
    expect(validateCimdMetadata(clientId, { ...validMetadata, client_name: "   " })).toMatchObject({
      valid: false,
    });
  });

  it("bounds client names by Unicode code points", () => {
    expect(
      validateCimdMetadata(clientId, { ...validMetadata, client_name: "x".repeat(80) }),
    ).toMatchObject({
      valid: true,
    });
    expect(
      validateCimdMetadata(clientId, { ...validMetadata, client_name: "x".repeat(81) }),
    ).toMatchObject({
      valid: false,
    });
    expect(
      validateCimdMetadata(clientId, { ...validMetadata, client_name: "🔐".repeat(80) }),
    ).toMatchObject({
      valid: true,
    });
  });

  it("uses manual redirect handling and rejects redirect responses", () => {
    expect(source).toContain('redirect: "manual"');
    expect(source).toContain("response.status >= 300 && response.status < 400");
    expect(source).toContain("Metadata document redirects are not allowed");
  });
});
```

- [ ] **Step 2: Verify the unpatched package fails**

Run:

```sh
vp test test/better-auth/cimd-package-contract.test.ts
```

Expected: FAIL because missing/oversized names currently validate and the source uses `redirect: "error"`.

- [ ] **Step 3: Extract the exact CIMD package**

Run:

```sh
vp exec pnpm patch @better-auth/cimd@1.7.0-rc.1 --edit-dir /tmp/opencode/triad-worker-safe-cimd
```

Expected: pnpm extracts only `@better-auth/cimd@1.7.0-rc.1`.

- [ ] **Step 4: Require a bounded client name**

In `/tmp/opencode/triad-worker-safe-cimd/dist/index.mjs`, add this validation immediately after the exact `client_id` check in `validateCimdMetadata`:

```js
if (typeof doc.client_name !== "string")
  return {
    valid: false,
    error: "client_name must be a string between 1 and 80 Unicode code points",
  };
const clientNameLength = [...doc.client_name.trim()].length;
if (clientNameLength < 1 || clientNameLength > 80)
  return {
    valid: false,
    error: "client_name must be a string between 1 and 80 Unicode code points",
  };
```

- [ ] **Step 5: Use Worker-compatible redirect rejection**

In `fetchAndValidateMetadataDocument`, change the fetch option to:

```js
redirect: "manual",
```

Then add this guard immediately after the fetch `try/catch` and before `response.ok`:

```js
if (response.status >= 300 && response.status < 400) {
  await response.body?.cancel();
  throw new APIError("BAD_REQUEST", {
    error: "invalid_client",
    error_description: "Metadata document redirects are not allowed",
  });
}
```

- [ ] **Step 6: Commit and apply the CIMD patch**

Run:

```sh
vp exec pnpm patch-commit /tmp/opencode/triad-worker-safe-cimd
vp install
```

Expected: pnpm creates one CIMD patch entry without altering the cumulative OAuth Provider patch.

- [ ] **Step 7: Verify package behavior**

Run:

```sh
vp test test/better-auth/cimd-package-contract.test.ts
```

Expected: PASS with 3 tests.

- [ ] **Step 8: Document the patch boundary**

Create `docs/superpowers/research/2026-07-14-worker-safe-cimd-patch.md`:

```markdown
# Worker-Safe CIMD Patch

`@better-auth/cimd@1.7.0-rc.1` already validates client IDs, public addresses, authentication methods, public keys, redirect URIs, response/grant types, origin-bound fields, a five-second timeout, and a 5 KiB streaming body limit.

Cloudflare Workers does not support the package's `redirect: "error"` fetch mode. The patch uses `redirect: "manual"`, rejects every 300-399 response, and cancels its body before returning `invalid_client`.

The patch also requires `client_name` with 1-80 Unicode code points after trimming. Triad's DNS and same-origin JWKS policy remains application configuration through CIMD's existing `allowFetch` and `originBoundFields` options.
```

- [ ] **Step 9: Run complete verification**

Run:

```sh
vp test test/better-auth/package-baseline.test.ts test/better-auth/subject-hook-contract.test.ts test/better-auth/public-dcr-guard-contract.test.ts test/better-auth/cimd-package-contract.test.ts
vp run check
vp run build
git diff --check
```

Expected: 14 focused tests pass, checks and build pass, and no whitespace errors are reported.

- [ ] **Step 10: Commit the Worker-safe CIMD patch**

Run:

```sh
git add pnpm-workspace.yaml pnpm-lock.yaml patches/@better-auth__cimd@1.7.0-rc.1.patch test/better-auth/cimd-package-contract.test.ts docs/superpowers/research/2026-07-14-worker-safe-cimd-patch.md
git commit -m "fix: make cimd fetch worker-safe"
```

Expected: one commit limited to the CIMD patch, patch metadata, contract test, and research note.
