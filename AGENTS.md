# Monorepo

This is a Solidity/TypeScript/Rust monorepo for multiple projects and languages. It is managed by Pnpm and VitePlus (oxc toolchain), and Cargo for Rust, and Foundry Forge for Solidity.

- Always read and follow `~/skills/instructions.md` and its referenced files.
- Creating new solidity/foundry projects: copy `solidity/template/` as starting template, and edit the package.json fields, readme and etc.
- Everything is managed by `vp` - which uses `pnpm` under the hood. Contributors need `vp` installed globally; `pnpm install` runs `vp config` through the `prepare` script to install the Git hooks.
- use conventional commits
- Use pnpm/vp filters to run commands inside a given project or package or app.
- Solidity dependencies are managed by Pnpm through Nodejs/node_modules.
- Solidity projects are in `solidity/*`.
- TypeScript packages and projects are at `packages/*`.
- Package PRs include a Changeset. Publishing goes through the committed scope mapping to `npm.wgw.lol`: locally with the GitHub CLI token, in CI with Depot CI OIDC that pnpm exchanges at the registry worker. The worker trusts only tokens for this repository on `master` from Depot organization `pcnr2v598s`, and reads the `workflow_ref` claim: `nightly.yml` may write `nightly` and `publish.yml` may write `latest`. VLT service tokens stay in the worker; never add registry secrets to CI.
- CI runs on Depot CI from `.depot/workflows/`. Every push to `master` runs `ci`: `check`, then `test`. When `ci` succeeds, `nightly`, `release`, and `publish` start through `workflow_run`. Both publishing workflows run `vp run build` first, which runs every `build` script under `packages/*` in dependency order with caching, then publish in dependency order. A package that emits or bundles declares a `build` script; tests always import source. `nightly` snapshot-versions pending Changesets and publishes only the packages that push changed, with the `nightly` dist-tag. `release` opens or updates the release PR from pending Changesets on every push and has no OIDC token. `publish` runs only for the merged release PR commit and publishes stable versions with `latest`, package tags, and GitHub Releases; if that publish fails, dispatch `publish` on `master` (`depot ci dispatch` or the Depot dashboard) and it publishes whatever is still missing. The owner reviews and merges release PRs by hand; never enable auto-merge on them.
- Open pull requests with `gh pr create`, then enable auto-merge at once with `gh pr merge --auto --squash`. Never merge by hand. GitHub merges when the master ruleset is satisfied, and that merge triggers the master workflows. Release PRs are the exception above: the owner merges them by hand and nobody enables auto-merge on them.
- The master ruleset requires the Depot CI `ci / check` and `ci / test` checks, the `do-not-merge` check, one approval of the latest push, and resolved review threads. New commits dismiss earlier approvals.
- Greptile reviews every pull request except Dependabot and release PRs, and approves clean ones. Fix its findings, reply, resolve the threads, and wait for its re-review.
- Do not approve a pull request unless the user says so, and then only with every thread resolved, a Greptile score of 5/5, and green checks.
- A `do-not-merge` label holds the pull request: the `do-not-merge` check fails while it is present and auto-merge waits. Do not remove the label. Keep babysitting the pull request meanwhile.
- Push to `master` directly only when the user asks; the pre-push hook runs the checks. Everything else goes through a pull request.
- Dependabot PRs are approved and auto-merged by `auto-merge-deps` with the `OLSTENLARCK_HQ_PAT` secret. Socket Optimize pushes verified overrides straight to master with the same PAT, opens a `socket optimize: needs attention` PR when verification fails, and an issue when it fails before producing changes.
- Apps and docs sites are at `apps/*`.
- Solidity projects' docs should be on their own `solidity/*/docs` folder.
- TypeScript toolchain is managed by VitePlus and `vp run check` is enough.
- Solidity projects are formatted, linted and build with Foundry, not Pnpm/VitePlus/Oxc.
- Solidity linting/format/build should happen with `vp`. At the root, `vp run solidity:check` runs fmt, lint, test, and build for every Solidity project with caching, `vp run solidity:test` runs only the tests with caching, and `vp run solidity:testing` runs all project test scripts in parallel without cache for a fresh fuzz. Prefer the per-project filter for day-to-day work.
- For changes within one Solidity project, run `vp run --filter <project> check`; use the root `vp run solidity:check` when changes span Solidity projects, without repeating the filtered check.
- Root `vp run check` handles TypeScript and non-Solidity formatting; run it only when those files need checking, not automatically alongside Solidity checks.
- Call `vp run --filter glyph-protocol test` to run Solidity tests only for that project. Same for any other project-scoped Solidity Forge command.
- Every Solidity/Foundry project has `fmt`, `test`, `lint` and `build` scripts.

Here some filtering patterns:

```
Filter Patterns:
  --filter <pattern>        Select by package name (e.g. foo, @scope/*)
  --filter ./<dir>          Select packages under a directory
  --filter {<dir>}          Same as ./<dir>, but allows traversal suffixes
  --filter <pattern>...     Select package and its dependencies
  --filter ...<pattern>     Select package and its dependents
  --filter <pattern>^...    Select only the dependencies (exclude the package itself)
  --filter !<pattern>       Exclude packages matching the pattern
```

## Apps and deployments

- Every app lives in `apps/<name>` with its own `package.json`, `cloudflare.config.ts`, and a `tsconfig.json` that extends the root one. Cloudflare Workers Builds deploys apps; GitHub Actions only checks them.
- Apps build and deploy with the Cloudflare CLI `cf` (open beta), never Wrangler. `cloudflare.config.ts` imports `bindings`, `triggers`, and `defineConfig` from `cf/config`; it is TypeScript, so a Worker type can derive its `Env` from it. Environments are modes: the config is a function of `mode`, and `cf build --mode nightly` selects the nightly Worker. `cf build` writes Build Output to `.cloudflare/output/v0/` (gitignored), and the `deploy` scripts run `cf deploy --prebuilt --mode <mode>` so Builds ships exactly what its build step produced. `cf d1 migrations apply <database-id>` takes the D1 ID and applies to the remote database unless `--local`. `cf` cannot stream logs or set one secret yet; use `npx wrangler tail <worker>` and `npx wrangler secret put <NAME> --name <worker>` for those.
- Astro apps use `@astrojs/cloudflare` 15 (beta), which reads `cloudflare.config.ts` through the Cloudflare Vite plugin 2 and has no `configPath` option. Plain Workers use `@cloudflare/vite-plugin` from a `vite.config.ts`.
- `master` is nightly for every app. Each nightly Worker has branch control on `master`, root directory `apps/<name>`, and build watch paths `apps/<name>/**`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and `patches/**` when the app uses a patched dependency.
- Production is a branch per app named `release/<name>`. Each production Worker has branch control on that branch and the same root directory and watch paths as its nightly Worker.
- The app's `promote` script fast-forwards only its own branch: `git fetch origin && git push origin origin/master:release/<name>`. Run it only when the user asks. Promoting one app never builds another app's Worker.
- An app without environments has one Worker with branch control on `master` and no `promote` script. Every merge that touches its paths deploys it. `apps/vlt-front-worker` is that shape.
- Two Depot CI pull request workflows in `.depot/workflows/` cover the whole workspace. `ci` runs `vp run check` and `vp run test` on every pull request and on pushes to `master`; `nightly`, `release`, and `publish` follow it on `master`. `solidity` runs `vp run solidity:check` when Solidity, the lockfile, the workspace file, or `vite.config.ts` change. Both restore the Vite+ task cache, so unchanged tasks replay. A new app or package needs no workflow of its own. The master ruleset requires the Depot checks `ci / check` and `ci / test`. `auto-merge-deps`, `socket-optimize`, and `do-not-merge` stay on GitHub Actions.
- Never run an app's `deploy` script locally unless the user explicitly asks. Builds runs it.
