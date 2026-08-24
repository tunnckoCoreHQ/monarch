Project: triad-auth. Better Auth OAuth/OIDC server on Cloudflare Workers + D1 + Astro.
Repo: git@github.com:olstenlarck/triad-auth.git

## Goal

Rebuild the deploy setup: two Workers deployed by Workers Builds, two fresh D1 databases, one squashed baseline migration, GitHub Actions for PR checks only, no secrets in GitHub. Wipe the existing Worker, D1, and all data. The wipe is approved.

## Current state

Worker `triad-auth` serves triad.wgw.lol from D1 `triad-auth` (cb0818ed-e2c1-4b41-bfe6-15d4399602e2). Staging is a preview alias of the same Worker on the same D1. Default branch `main`. Migrations 0001 to 0004. PR #13 may still be open.

## Target

- Branches: `master` is the default dev branch (rename of `main`). `stable` is the production pointer, moved only by fast-forward push.
- Workers: `triad-auth-nightly` deploys from `master`, serves triad-auth-nightly.wgw.lol. `triad-auth` deploys from `stable`, serves triad-auth.wgw.lol. Custom domains via `routes = [{ pattern = "...", custom_domain = true }]`.
- Configs: `wrangler.toml` for prod, `wrangler.nightly.toml` for nightly with its own D1 binding and `AUTH_ORIGIN = "https://triad-auth-nightly.wgw.lol"`. No `[env.*]` blocks.
- Migrations: one `0001-initial.sql`, the squash of 0001 to 0004.
- Builds deploy commands: `pnpm run deploy:nightly` and `pnpm run deploy`, each `wrangler d1 migrations apply DB --remote -c <config> && wrangler deploy -c <config>`. Non-production-branch builds off.
- Scripts: add `deploy`, `deploy:nightly`, and `promote` (`git push origin origin/master:stable`), keep `db:migrate:local`, drop `deploy:staging`.
- Checks workflow on PRs: `vp run check`, `vp test --run`, `vp run build`. Steps:

```yaml
steps:
  # SHA-pinned; let Renovate bump it
  - uses: actions/checkout@<sha>
  # SHA-pinned; let Renovate bump it
  - uses: socketdev/action@<sha>
    with:
      mode: firewall-free
  - uses: voidzero-dev/setup-vp@v1.17.0
    with:
      sfw: true
      cache: true
      run-install: true
      node-version: "lts"
```

- Docs: new `CONTRIBUTING.md` from scratch with the whole flow, replacing `DEPLOY.md`.

## Steps

1. Squash-merge PR #13 if open. Rename the branch: `gh api -X POST repos/{owner}/{repo}/branches/main/rename -f new_name=master`, then `git fetch` and `git branch -m` locally.
2. Squash the migrations. Update `test/better-auth/schema-tooling.test.ts`: migration file list, recomputed sha256 of 0001, assertions for the walletRequest and walletCapabilityRequest tables and the `walletCapable` and `encryptedData` passkey columns.
3. Run `wrangler delete` for the old `triad-auth` Worker. Run `wrangler d1 list` and delete the old `triad-auth` database and stale triad databases.
4. Run `wrangler d1 create triad-auth` and `wrangler d1 create triad-auth-nightly`, put the ids into the configs. Deploy each Worker once locally with `wrangler deploy -c <config>` to create the Workers and domains.
5. Set secrets per Worker with `wrangler secret put <NAME> -c <config>`, fresh distinct values: BETTER_AUTH_SECRET, IDENTIFIER_SECRET, RATE_LIMIT_SECRET as random 32-byte base64url; ENCRYPTION_SECRETS as `{"active":"k1","secrets":{"k1":"<canonical 43-char base64url of 32 bytes>"}}`. Google client id and secret from `.dev.vars` or `.env`, else ask the user. GitHub and Twitter pairs: reuse if found, else placeholders; check `src/better-auth/configuration.ts` tolerates them.
6. Write the workflow, the scripts, and `CONTRIBUTING.md`. Delete `DEPLOY.md`.
7. Verify: `vp run check`, `vp test --run`, `vp run build`, restart from the first after any fix. Open a PR into `master`.
8. After merge: nightly Build green, smoke-test https://triad-auth-nightly.wgw.lol (passkey sign-in needs no providers). Then `git push origin <sha>:refs/heads/stable` and confirm https://triad-auth.wgw.lol deploys.

## User steps

- Dashboard: connect the repo to both Workers in Workers Builds. Set production branch, build command, deploy command. Non-production builds off.
- Dashboard: My Profile, API Tokens: add D1 Edit to the auto-generated Builds token. It lacks D1, and migrations fail without it.
- Google console: add the callback URI `/api/auth/callback/google` on both new hosts.

## Gotchas

- vp reserves the `test` task name. No `"test"` script in package.json.
- On the first Build run, check that pnpm applies the patchedDependencies and the free-plan Builds minutes are enough.
