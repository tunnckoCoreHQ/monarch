# Monorepo

This is a Solidity/TypeScript/Rust monorepo for multiple projects and languages. It is managed by Pnpm and VitePlus (oxc toolchain), and Cargo for Rust, and Foundry Forge for Solidity.

- Always read and follow `~/skills/instructions.md` and its referenced files.
- Creating new solidity/foundry projects: copy `solidity/template/` as starting template, and edit the package.json fields, readme and etc.
- Everything is managed by `vp` - which uses `pnpm` under the hood.
- use conventional commits
- Use pnpm/vp filters to run commands inside a given project or package or app.
- Solidity dependencies are managed by Pnpm through Nodejs/node_modules.
- Solidity projects are in `solidity/*`.
- TypeScript packages and projects are at `packages/*`.
- Apps and docs sites are at `apps/*`.
- Solidity projects' docs should be on their own `solidity/*/docs` folder.
- TypeScript toolchain is managed by VitePlus and `vp run check` is enough.
- Solidity projects are formatted, linted and build with Foundry, not Pnpm/VitePlus/Oxc.
- Solidity linting/format/build should happen with `vp`. At the root, `vp run solidity:check` runs fmt, lint, test, and build for every Solidity project with caching, `vp run solidity:test` runs only the tests with caching, and `vp run solidity:testing` runs all project test scripts in parallel without cache for a fresh fuzz. Prefer the per-project filter for day-to-day work.
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

- Every app lives in `apps/<name>` with its own `package.json`, `wrangler.jsonc`, and a `tsconfig.json` that extends the root one. Cloudflare Workers Builds deploys apps; GitHub Actions only checks them.
- `master` is nightly for every app. Each nightly Worker has branch control on `master`, root directory `apps/<name>`, and build watch paths `apps/<name>/**`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and `patches/**` when the app uses a patched dependency.
- Production is a branch per app named `release/<name>`. Each production Worker has branch control on that branch and the same root directory and watch paths as its nightly Worker.
- The app's `promote` script fast-forwards only its own branch: `git fetch origin && git push origin origin/master:release/<name>`. Run it only when the user asks. Promoting one app never builds another app's Worker.
- An app without environments has one Worker with branch control on `master` and no `promote` script. Every merge that touches its paths deploys it. `apps/vlt-front-worker` is that shape.
- Each app has its own workflow in `.github/workflows/<name>.yml`, filtered to its paths, running its tests and build. `checks.yml` lints and type-checks the whole workspace. Copy `triad-auth.yml` for a new app.
- Never run an app's `deploy` script locally unless the user explicitly asks. Builds runs it.
