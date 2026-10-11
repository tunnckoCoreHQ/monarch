# Contributing

Triad is a Better Auth OAuth/OIDC server on Cloudflare Workers, D1, and Astro. This file describes the whole flow from a local change to production.

## Environments

| Mode | Worker | D1 | Origin | Deployed by |
| --- | --- | --- | --- | --- |
| `nightly` | `triad-auth-nightly` | `triad-auth-nightly` | `https://triad-auth-nightly.wgw.lol` | `deploy-nightly`, after every `master` push that touches the app |
| `production` | `triad-auth` | `triad-auth` | `https://triad-auth.wgw.lol` | `deploy-prod`, started by hand |

`master` is the default branch. Every pull request targets it. Nothing deploys from a pull request or from any other branch.

Both Workers are described by one `cloudflare.config.ts`, the typed config of the Cloudflare CLI `cf` (beta). The config is a function of the mode: `--mode nightly` selects `triad-auth-nightly`, and every other mode, including the default `production`, selects `triad-auth`. The two Workers share nothing. Each has its own D1 database, its own secrets, and its own `AUTH_ORIGIN`.

## Local development

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm run db:migrate:local
pnpm run dev
```

Fill `.env` with local values. `pnpm run dev` runs `cf dev`, which runs `astro dev` through the Cloudflare Vite plugin: it serves the Worker from `src/index.ts` with the secrets from `.env` and local D1 storage in `.cloudflare/state/`. `db:migrate:local` applies the migrations to that same storage; the `cf` beta keeps running after it prints the result, so stop it with Ctrl-C.

## Making a change

1. Branch from `master`.
2. Make the change. For a schema change, add a new numbered file in `migrations/`. Never edit `migrations/0001-initial.sql` or any migration already applied.
3. Run the checks in this order and restart from the first after any fix:

   ```sh
   turbo run check --filter=triad-auth
   turbo run test --filter=triad-auth
   turbo run build --filter=triad-auth
   ```

4. Open a pull request into `master`. The RWX `ci` run checks and tests the affected packages. Nothing deploys from a pull request. Enable auto-merge with `gh pr merge --auto --squash`; GitHub merges once the required checks pass, one approval is in, and review threads are resolved.
5. Squash-merge. `deploy-nightly` runs after `ci` succeeds on `master`: it applies pending migrations to the nightly database, then builds and deploys the Worker.

## Releasing to production

Confirm nightly is healthy at `https://triad-auth-nightly.wgw.lol`, then:

```sh
pnpm run promote
```

This dispatches `monarch-deploy-prod` on RWX for this app on `master`. It applies pending migrations to the production database, then builds the `master` head and deploys the `triad-auth` Worker. `pnpm run apps:deploy:prod` from the repository root does the same for every app with a `deploy:prod` script.

Every page footer shows a `BUILD <sha>` link with the commit the running Worker was built from.

## Build and deploy scripts

| Script | What it does |
| --- | --- |
| `pnpm run build` | `cf build`: bundles `src/index.ts` and prerenders every page |
| `pnpm run deploy:nightly` | `cf d1 migrations apply` on the nightly database, then `cf deploy --mode nightly` |
| `pnpm run deploy:prod` | `cf d1 migrations apply` on the production database, then `cf deploy` |
| `pnpm run promote` | dispatches `monarch-deploy-prod` for `triad-auth` |

`cf d1 migrations apply` applies the pending files in `migrations/` to the D1 database, then `cf deploy` builds the Worker and its static assets and uploads them. RWX runs the deploy scripts. Do not run them by hand unless asked.

## Secrets

Each Worker needs the same twelve secret names. They are set on the Worker and persist across deploys; the deploy scripts never touch them. The first four differ per Worker. The eight provider values are shared by both Workers, because one OAuth app per provider registers both callback origins. Set or rotate one with `npx wrangler secret put <NAME> --name <worker>`; `cf` cannot set a single secret yet.

| Name | Value |
| --- | --- |
| `BETTER_AUTH_SECRET` | 32 random bytes, base64url |
| `IDENTIFIER_SECRET` | 32 random bytes, base64url, distinct from the others |
| `RATE_LIMIT_SECRET` | 32 random bytes, base64url, distinct from the others |
| `ENCRYPTION_SECRETS` | `{"active":"k1","secrets":{"k1":"<43-char base64url of 32 random bytes>"}}` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | From the Google Cloud console |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | From the GitHub OAuth app |
| `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET` | From the X developer portal |
| `AGENTID_CLIENT_ID`, `AGENTID_CLIENT_SECRET` | From a registered application in the AgentID console |

Generate random values with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`. Never reuse one of the first four values between the two Workers. Better Auth owns ES256 signing and JWKS persistence, so there is no signing secret.

Register the callback URI `/api/auth/callback/<provider>` on both origins with each provider.

## First-time setup

Done once per Cloudflare account. Skip this if both Workers already exist.

Out of scope for now: these docs assume both Workers, both D1 databases, the routes, and the secrets already exist.

No secrets live in GitHub. RWX runs the checks and the deploys.
