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

## After merging to `main`

1. Stop using the feature worktree.
2. Switch to the `main` worktree.
3. Update `main` to `origin/main` and verify both commits match.
4. Never delete or recreate the D1 database.
5. Run `vp run db:migrate`.
6. Run `vp run deploy:staging`.
7. Wait for deployment and validate staging.

## Production and Staging management

- The "prod" means production environment at `triad.wgw.lol`.
- The "staging" means staging environment at `staging-triad-auth.equator-owl-studio.workers.dev`.
- Prod is sitting on `prod` branch. Staging is on `main`.
- Never deploy production from `main` unless explicitly requested.
- Never promote from `main` to `prod` automatically.
