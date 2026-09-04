# Project rules

- Follow `~/skills/instructions.md`.
- For code, follow `~/skills/clean_code.md`.
- For UI work, follow `~/skills/product_design.md`.
- Keep solutions small and direct.
- Put generic reusable helpers in `src/utils.ts` and export them. Before adding a local helper, check the central utilities and existing exports so the same logic is not implemented twice.
- Do not preserve superseded APIs or add regression tests for them during refactors.
- Use TypeScript 7, pinned 7.0.2 is fine.
- Do not edit `vite.config.ts` unless very necessary, ask the user to approve.
- Use conventional commits. Obviously.
- Do not hard-wrap prose.
- Talk to the user in ASD-STE100 Simplified Technical English.
- Never use any built-in browser or browser tool. Unless explicitly asked.

## Verification

Before a PR, run these sequentially and restart from the first command after any fix:

1. `vp run check`
2. `vp test --run`
3. `vp run build`

## Database migrations

- Never modify `migrations/0001-initial.sql`.
- Add a new numbered migration for every schema change.
- Never modify a migration already applied to production.
- `vp run db:generate` creates `.generated/auth-schema.sql` for reference only.
- Apply migrations with `vp run db:migrate` or `vp run db:migrate:local`.

## Git and GitHub

- Follow the Git and GitHub rules in `~/skills/instructions.md`.
- Squash-merge PRs. Never create merge commits.
- Use the babysit pr skill, only when asked, and only if it exists in the project.

## Branches and environments

- `master` is the default branch. Pull requests merge into `master`.
- Workers Builds deploys `master` to the `triad-auth-nightly` Worker at `https://triad-auth-nightly.wgw.lol`.
- `stable` is the production pointer. Workers Builds deploys `stable` to the `triad-auth` Worker at `https://triad-auth.wgw.lol`.
- Cut a production release with `vp run promote`. It fast-forwards `stable` to `origin/master`. Run it only when the user asks.
- Never run `vp run deploy` or `vp run deploy:nightly` locally unless the user explicitly asks. Builds runs them.
- Each Worker has its own D1 database and its own secrets. See `CONTRIBUTING.md`.
