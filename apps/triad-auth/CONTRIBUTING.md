# Contributing

Triad is a Better Auth OAuth/OIDC server on Cloudflare Workers, D1, and Astro. This file describes the whole flow from a local change to production.

## Environments

| Branch               | Worker               | Mode         | D1                   | Origin                               |
| -------------------- | -------------------- | ------------ | -------------------- | ------------------------------------ |
| `master`             | `triad-auth-nightly` | `nightly`    | `triad-auth-nightly` | `https://triad-auth-nightly.wgw.lol` |
| `release/triad-auth` | `triad-auth`         | `production` | `triad-auth`         | `https://triad-auth.wgw.lol`         |

`master` is the default branch. Every pull request targets it. Cloudflare Workers Builds deploys `master` to nightly on each push. `release/triad-auth` is the production pointer. Builds deploys it to production when it moves. No other branch deploys.

Both Workers are described by one `cloudflare.config.ts`. The file exports a function of the build mode: `--mode nightly` returns the nightly Worker, every other mode returns production. The two Workers share nothing. Each has its own D1 database, its own secrets, and its own `AUTH_ORIGIN`.

## Local development

```sh
vp install --frozen-lockfile
cp .dev.vars.example .dev.vars
vp run db:migrate:local
vp run dev
```

Fill `.dev.vars` with local values. `vp run dev` runs `cf dev`, which starts Astro with the production bindings from `cloudflare.config.ts` against local D1 storage in `.cloudflare/state/`. `db:migrate:local` applies the migrations to that same local storage.

## Making a change

1. Branch from `master`.
2. Make the change. For a schema change, add a new numbered file in `migrations/`. Never edit `migrations/0001-initial.sql` or any migration already applied.
3. Run the checks in this order and restart from the first after any fix:

   ```sh
   vp run check
   vp test --run apps/triad-auth
   vp run --filter triad-auth build
   ```

4. Open a pull request into `master`. The Depot CI `ci` workflow runs `vp run check` and `vp run test`; its `solidity` workflow runs when Solidity or shared dependency files change. Nothing deploys from a pull request. Enable auto-merge with `gh pr merge --auto --squash`; GitHub merges once the required checks pass, one approval is in, and review threads are resolved.
5. Squash-merge. Builds deploys the merge commit to nightly. The build command targets the nightly mode, and the deploy command applies pending migrations first, then uploads the Worker.

## Releasing to production

Confirm nightly is healthy at `https://triad-auth-nightly.wgw.lol`, then:

```sh
vp run promote
```

This fast-forwards `release/triad-auth` to `origin/master`. Builds deploys it to `triad-auth`. To release a specific commit instead, push it directly: `git push origin <sha>:refs/heads/release/triad-auth`.

Every page footer shows a `BUILD <sha>` link with the commit the running Worker was built from. It can trail the branch pointer: Builds skips a push whose changes fall outside the watch paths, so a promote that only touches other apps or root tooling does not rebuild this Worker.

## Build and deploy scripts

| Script                  | What it does                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `vp run build`          | `cf build`: Astro build for the production Worker                                          |
| `vp run build:nightly`  | `cf build --mode nightly`: Astro build for the nightly Worker                              |
| `vp run deploy`         | `cf d1 migrations apply <production D1 id>`, then `cf deploy --prebuilt --mode production` |
| `vp run deploy:nightly` | `cf d1 migrations apply <nightly D1 id>`, then `cf deploy --prebuilt --mode nightly`       |
| `vp run promote`        | `git fetch origin && git push origin origin/master:release/triad-auth`                     |

`cf build` runs `astro build` and writes Build Output to `.cloudflare/output/v0/`. The `deploy` scripts pass `--prebuilt`, so they upload that output instead of building again, and the mode has to match the build. Always run the matching build before a deploy.

Builds runs the build and deploy scripts. Do not run them by hand except during first-time setup.

## First-time setup

Done once per Cloudflare account. Skip this if both Workers already exist.

### Databases and Workers

```sh
vp exec cf auth login
vp exec cf d1 create --name triad-auth-nightly
vp exec cf d1 create --name triad-auth
```

Copy each database `id` into `cloudflare.config.ts` and the matching `deploy` script. Then build and deploy each Worker once so it exists:

```sh
vp run build:nightly && vp run deploy:nightly
vp run build && vp run deploy
```

Create two proxied DNS records in the `wgw.lol` zone, `triad-auth-nightly` and `triad-auth`, so the route patterns resolve.

### Secrets

Each Worker needs the same ten secret names with its own values. `cf` cannot set a single secret yet, so set them with Wrangler by Worker name, or upload a file with a new version:

```sh
npx wrangler secret put <NAME> --name triad-auth-nightly
npx wrangler secret put <NAME> --name triad-auth
vp exec cf deploy --prebuilt --mode nightly --secrets-file <path>
```

| Name                                         | Value                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                         | 32 random bytes, base64url                                                  |
| `IDENTIFIER_SECRET`                          | 32 random bytes, base64url, distinct from the others                        |
| `RATE_LIMIT_SECRET`                          | 32 random bytes, base64url, distinct from the others                        |
| `ENCRYPTION_SECRETS`                         | `{"active":"k1","secrets":{"k1":"<43-char base64url of 32 random bytes>"}}` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`   | From the Google Cloud console                                               |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`   | From the GitHub OAuth app                                                   |
| `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET` | From the X developer portal                                                 |

Generate random values with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`. Never reuse a value between the two Workers. Better Auth owns ES256 signing and JWKS persistence, so there is no signing secret.

Register the callback URI `/api/auth/callback/<provider>` on both origins with each provider.

### Workers Builds

In the Cloudflare dashboard, connect the GitHub repository to both Workers:

| Setting                            | `triad-auth-nightly`      | `triad-auth`         |
| ---------------------------------- | ------------------------- | -------------------- |
| Production branch                  | `master`                  | `release/triad-auth` |
| Build command                      | `pnpm run build:nightly`  | `pnpm run build`     |
| Deploy command                     | `pnpm run deploy:nightly` | `pnpm run deploy`    |
| Builds for non-production branches | Off                       | Off                  |

`cf` needs Node.js 22.18 or later; the Builds image ships Node.js 24 by default. The auto-generated Builds API token lacks D1 permission. Under My Profile, API Tokens, add D1 Edit to it. Migrations fail without it.

No secrets live in GitHub. Depot CI runs the checks; GitHub Actions only automates Dependabot merges and Socket Optimize.
