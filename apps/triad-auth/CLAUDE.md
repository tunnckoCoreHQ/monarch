# Project rules

- always read `~/skills/instructions.md` - it contains everything

## Verification

Before a PR, run these sequentially and restart from the first command after any fix:

1. `vp run check`
2. `vp test --run`
3. `vp run build`

## Branches and environments

- `master` is the default branch. Pull requests merge into `master`.
- Workers Builds deploys `master` to the `triad-auth-nightly` Worker at `https://triad-auth-nightly.wgw.lol`.
- `stable` is the production pointer. Workers Builds deploys `stable` to the `triad-auth` Worker at `https://triad-auth.wgw.lol`.
- Cut a production release with `vp run promote`. It fast-forwards `stable` to `origin/master`. Run it only when the user asks.
- Never run `vp run deploy` or `vp run deploy:nightly` locally unless the user explicitly asks. Builds runs them.
- Each Worker has its own D1 database and its own secrets. See `CONTRIBUTING.md`.
