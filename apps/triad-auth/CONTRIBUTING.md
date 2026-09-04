# Contributing

Triad is a Better Auth OAuth/OIDC server on Cloudflare Workers, D1, and Astro. This file describes the whole flow from a local change to production.

## Environments

| Branch               | Worker               | Config                   | D1                   | Origin                               |
| -------------------- | -------------------- | ------------------------ | -------------------- | ------------------------------------ |
| `master`             | `triad-auth-nightly` | `wrangler.nightly.jsonc` | `triad-auth-nightly` | `https://triad-auth-nightly.wgw.lol` |
| `release/triad-auth` | `triad-auth`         | `wrangler.jsonc`         | `triad-auth`         | `https://triad-auth.wgw.lol`         |

`master` is the default branch. Every pull request targets it. Cloudflare Workers Builds deploys `master` to nightly on each push. `release/triad-auth` is the production pointer. Builds deploys it to production when it moves. No other branch deploys.

The two Workers share nothing. Each has its own D1 database, its own secrets, and its own `AUTH_ORIGIN`.

## Local development

```sh
vp install --frozen-lockfile
cp .dev.vars.example .dev.vars
vp run db:migrate:local
vp run dev
```

Fill `.dev.vars` with local values. `vp run dev` uses `wrangler.jsonc` bindings against local D1 storage.

## Making a change

1. Branch from `master`.
2. Make the change. For a schema change, add a new numbered file in `migrations/`. Never edit `migrations/0001-initial.sql` or any migration already applied.
3. Run the checks in this order and restart from the first after any fix:

   ```sh
   vp run check
   vp test --run apps/triad-auth
   vp run --filter triad-auth build
   ```

4. Open a pull request into `master`. The `checks` GitHub Actions workflow runs the same three commands. Nothing deploys from a pull request.
5. Squash-merge. Builds deploys the merge commit to nightly. The build command targets the nightly config, and the deploy command applies pending migrations first, then uploads the Worker.

## Releasing to production

Confirm nightly is healthy at `https://triad-auth-nightly.wgw.lol`, then:

```sh
vp run promote
```

This fast-forwards `release/triad-auth` to `origin/master`. Builds deploys it to `triad-auth`. To release a specific commit instead, push it directly: `git push origin <sha>:refs/heads/release/triad-auth`.

## Build and deploy scripts

| Script                  | What it does                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `vp run build`          | Astro build against `wrangler.jsonc`                                                         |
| `vp run build:nightly`  | Astro build against `wrangler.nightly.jsonc`                                                 |
| `vp run deploy`         | `wrangler d1 migrations apply DB --remote -c wrangler.jsonc`, then `wrangler deploy`         |
| `vp run deploy:nightly` | `wrangler d1 migrations apply DB --remote -c wrangler.nightly.jsonc`, then `wrangler deploy` |
| `vp run promote`        | `git fetch origin && git push origin origin/master:release/triad-auth`                       |

The Astro Cloudflare adapter reads the selected Wrangler config at build time and writes the final Worker config to `dist/server/wrangler.json`. `wrangler deploy` follows the redirect in `.wrangler/deploy/config.json` to that file, so it takes no `-c` flag. The `WRANGLER_CONFIG` variable in `astro.config.mjs` picks the source config. Always run the matching build before a deploy.

Builds runs the build and deploy scripts. Do not run them by hand except during first-time setup.

## First-time setup

Done once per Cloudflare account. Skip this if both Workers already exist.

### Databases and Workers

```sh
vp exec wrangler login
vp exec wrangler d1 create triad-auth-nightly
vp exec wrangler d1 create triad-auth
```

Copy each `database_id` into the matching config. Then build and deploy each Worker once so it exists:

```sh
vp run build:nightly && vp run deploy:nightly
vp run build && vp run deploy
```

Create two proxied DNS records in the `wgw.lol` zone, `triad-auth-nightly` and `triad-auth`, so the route patterns resolve.

### Secrets

Each Worker needs the same ten secret names with its own values. Set them per config:

```sh
vp exec wrangler secret put <NAME> -c wrangler.nightly.jsonc
vp exec wrangler secret put <NAME> -c wrangler.jsonc
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

The auto-generated Builds API token lacks D1 permission. Under My Profile, API Tokens, add D1 Edit to it. Migrations fail without it.

No secrets live in GitHub. GitHub Actions only runs checks.
