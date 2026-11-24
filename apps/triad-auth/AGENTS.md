# Project rules

- always read `~/skills/instructions.md` - it contains everything
- Take decisions and rules from `docs/adr/`, `CONTEXT.md`, and the code. The `docs/superpowers/` folder is an archive of old plans and progress. Do not read it or cite it unless the user asks.

## Verification

Before a PR, run these sequentially and restart from the first command after any fix:

1. `turbo run check --filter=triad-auth` - monorepo root
2. `turbo run test --filter=triad-auth`
3. `turbo run build --filter=triad-auth`

## Branches and environments

- `master` is the default branch. Pull requests merge into `master`.
- The RWX `deploy-nightly` task deploys every `master` push that touches the app to the `triad-auth-nightly` Worker at `https://triad-auth-nightly.wgw.lol`, built with `--mode nightly`.
- Production is the default `production` mode, the `triad-auth` Worker at `https://triad-auth.wgw.lol`. Cut a production release with `pnpm run promote`, which dispatches `monarch-deploy-prod` on RWX for this app on `master`. Run it only when the user asks.
- Never run `pnpm run deploy:nightly` or `pnpm run deploy:prod` locally unless the user explicitly asks. RWX runs them.
- Each Worker has its own D1 database and its own secrets. See `CONTRIBUTING.md`.
