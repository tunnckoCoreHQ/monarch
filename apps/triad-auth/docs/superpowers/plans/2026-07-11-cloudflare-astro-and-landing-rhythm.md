# Cloudflare Astro and Landing Rhythm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct landing-page composition and build Triad through Astro's official Cloudflare Vite-plugin integration without changing protocol behavior.

**Architecture:** Move visual evidence earlier and constrain the device callout with responsive typography. Install `@astrojs/cloudflare`, prerender all pages into Workers Assets, and let the custom Hono Worker delegate Astro's private prerender control requests to the Cloudflare handler while retaining API route ownership and its direct asset fallback.

**Tech Stack:** Astro 7, `@astrojs/cloudflare`, `@cloudflare/vite-plugin`, Vite+ TypeScript 6, Hono, Wrangler, Workers Assets, D1.

## Global Constraints

- Keep the browser session at 30 days.
- Preserve all OAuth, OIDC, device, account, and security behavior.
- Keep every Astro page prerendered and served as a Cloudflare asset.
- Keep `src/index.ts` as the custom Worker entrypoint.
- Keep canonical trailing-slash URLs and the existing Workers issuer.
- Do not add a raw second `cloudflare()` Vite plugin; `@astrojs/cloudflare` owns that integration.
- Use focused commits and push each commit immediately.
- Run `vp test`, `vp run check`, and `vp run build` before deployment.

---

### Task 1: Landing rhythm and device composition

**Files:**

- Modify: `test/ui.test.ts`
- Modify: `src/pages/index.astro`
- Modify: `src/styles/global.css`

**Interfaces:**

- Preserves all landing content and links.
- Changes only section order and responsive typography.

- [ ] **Step 1: Write failing structure and wrapping tests**

```ts
const hero = landing.indexOf('class="hero shell"');
const band = landing.indexOf('class="provider-band"');
const identity = landing.indexOf('class="identity-model shell"');

expect(hero).toBeLessThan(band);
expect(band).toBeLessThan(identity);
expect(css).toMatch(/\.device-code\s*\{[^}]*white-space: nowrap;/s);
expect(css).toMatch(/\.device-callout h2 span\s*\{[^}]*white-space: nowrap;/s);
```

- [ ] **Step 2: Run the UI test and verify expected failure**

Run: `vp test test/ui.test.ts`

Expected: provider band order and non-wrapping assertions fail.

- [ ] **Step 3: Move the band and constrain display phrases**

Move the existing provider-band section directly after the hero. Add `white-space: nowrap` to `.device-code` and `.device-callout h2 span`, reduce the desktop callout heading clamp, and override the span to normal wrapping below 760px if needed to avoid overflow.

- [ ] **Step 4: Verify, commit, and push**

Run: `vp test test/ui.test.ts`

Commit and push:

```bash
git add src/pages/index.astro src/styles/global.css test/ui.test.ts
git commit -m "fix: strengthen landing page rhythm"
git push origin main
```

### Task 2: Cloudflare Astro adapter and prerender bridge

**Files:**

- Modify: `test/config.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `astro.config.mjs`
- Modify: `vite.config.ts`
- Modify: `src/index.ts`
- Modify: `src/pages/index.astro`
- Modify: `src/pages/me.astro`
- Modify: `src/pages/consent.astro`
- Modify: `src/pages/device/verify.astro`
- Modify: `src/pages/demo/index.astro`
- Modify: `src/pages/demo/callback.astro`
- Modify: `README.md`

**Interfaces:**

- Adds: `@astrojs/cloudflare` adapter with `imageService: "passthrough"`.
- Adds: Astro's custom-entrypoint handler from `@astrojs/cloudflare/handler`.
- Keeps: Hono's `ExportedHandler<Env>` default export and Wrangler `main = "src/index.ts"`.

- [ ] **Step 1: Write failing configuration tests**

Require the package, adapter, scripts, and prerender contract:

```ts
expect(packageJson.dependencies).toHaveProperty("@astrojs/cloudflare");
expect(packageJson.scripts.build).toBe(
  "vp exec astro build && node scripts/generate-csp-hashes.mjs",
);
expect(packageJson.scripts.deploy).toBe("vp run build && vp exec wrangler deploy");
expect(astroConfig).toContain('from "@astrojs/cloudflare"');
expect(astroConfig).toContain("adapter: cloudflare(");
expect(astroConfig).toContain('output: "server"');
expect(applicationSources.every((source) => source.includes("export const prerender = true"))).toBe(
  true,
);
```

- [ ] **Step 2: Run the config test and verify expected failure**

Run: `vp test test/config.test.ts`

Expected: dependency, adapter, scripts, and prerender assertions fail.

- [ ] **Step 3: Install the supported adapter**

Run: `vp exec pnpm add @astrojs/cloudflare@^14.1.2`

Expected: package and lockfile include the adapter and its compatible Cloudflare Vite plugin.

- [ ] **Step 4: Configure Astro and prerender pages**

Use:

```js
import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

export default defineConfig({
  adapter: cloudflare({ imageService: "passthrough" }),
  output: "server",
  trailingSlash: "always",
  build: { format: "directory" },
});
```

Add `export const prerender = true;` to every Astro page frontmatter.

- [ ] **Step 5: Delegate Astro prerender requests to the Cloudflare handler**

Keep application routes and ordinary asset fallback unchanged, and route only Astro's private build requests through the adapter handler:

```ts
app.notFound(async (c) => {
  if (isProtocolPath(c.req.path)) {
    return c.text("404 Not Found", 404);
  }

  if (c.req.path.startsWith("/__astro_")) {
    const { handle } = await import("@astrojs/cloudflare/handler");

    return handle(c.req.raw, c.env, c.executionCtx);
  }

  return c.env.ASSETS.fetch(c.req.raw);
});
```

The dynamic import keeps Node-based route tests from resolving the workerd-only `cloudflare:workers` module. Runtime pages remain static assets and preserve the existing security-header middleware path.

- [ ] **Step 6: Normalize scripts and Vite+ task ownership**

Set package scripts:

```json
{
  "build": "vp exec astro build && node scripts/generate-csp-hashes.mjs",
  "deploy": "vp run build && vp exec wrangler deploy",
  "dev": "vp exec astro dev",
  "preview": "vp run build && vp exec astro preview"
}
```

Remove the duplicate custom `run.tasks.build` definition from `vite.config.ts`. Make the check task build the adapter output before Wrangler dry-run:

```ts
command:
  "vp check --fix && vp exec astro build && node scripts/generate-csp-hashes.mjs && vp exec wrangler deploy --dry-run",
```

- [ ] **Step 7: Build and inspect generated output**

Run: `vp run --no-cache build`

Expected: six prerendered pages, a generated Worker bundle/configuration, and hashed static assets under `dist`.

Run: `vp exec wrangler deploy --dry-run`

Expected: Wrangler reads the adapter build and reports the existing D1, ASSETS, and ISSUER bindings.

- [ ] **Step 8: Verify, commit, and push**

Run: `vp test test/config.test.ts test/ui.test.ts test/oauth.test.ts test/account.test.ts`

Commit and push:

```bash
git add package.json pnpm-lock.yaml astro.config.mjs vite.config.ts src/index.ts src/pages README.md test/config.test.ts
git commit -m "build: use cloudflare astro adapter"
git push origin main
```

### Task 3: Full release verification

**Files:**

- Modify only files required by verified build or test failures.

**Interfaces:**

- Produces a Cloudflare-adapter Worker deployment with prerendered assets.

- [ ] **Step 1: Run all verification sequentially**

```bash
vp test
vp run check
vp run --no-cache build
```

Expected: all tests pass, checks are clean, and adapter output builds without cache replay.

- [ ] **Step 2: Request an independent review**

Review the focused commit range for routing precedence, static security headers, build output correctness, and mobile overflow. Fix all blocking and important findings with tests.

- [ ] **Step 3: Deploy and smoke-test**

Run: `vp run --no-cache deploy`

Verify `/`, one hashed CSS asset, discovery, JWKS, `/api/providers`, and `/api/me`. Confirm the landing order and one-line desktop device phrases in released HTML/CSS.

- [ ] **Step 4: Report release state**

Report focused commit hashes, test count, Worker version, live endpoint results, and the unchanged 30-day browser-session duration.
