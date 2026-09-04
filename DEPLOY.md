# Deploy Triad

Triad uses one Cloudflare Worker and one D1 database. The `prod` branch is production. The `main` branch is the stable
staging preview. No other branch deploys.

| Branch | Deployment                           | Origin                                                      |
| ------ | ------------------------------------ | ----------------------------------------------------------- |
| `prod` | Active `triad-auth` deployment       | `https://triad.wgw.lol`                                     |
| `main` | Aliased `triad-auth` preview version | `https://staging-triad-auth.equator-owl-studio.workers.dev` |

Both versions share the Worker secrets and the `triad-auth` D1 database. Their `AUTH_ORIGIN` bindings differ because
the value is captured in each uploaded Worker version.

## First-time setup

Install the locked dependencies and authenticate Wrangler:

```sh
vp install --frozen-lockfile
vp exec wrangler login
```

Create the D1 database, copy its ID into `wrangler.toml`, and apply all checked-in migrations in order:

```sh
vp exec wrangler d1 create triad-auth
vp run db:migrate
```

`migrations/0001-initial.sql` is the immutable production baseline. Never edit or regenerate it, and never rewrite any migration already applied to production. Every schema change must be a new, monotonically numbered SQL file in `migrations/`.

`vp run db:generate` writes the current Better Auth schema to the ignored `.generated/auth-schema.sql` reference file. Compare that reference with the committed migrations when authoring a new additive migration; do not copy it over an existing migration.

## Secrets

Add the ten required secrets to `triad-auth`:

```sh
vp exec wrangler secret put BETTER_AUTH_SECRET
vp exec wrangler secret put IDENTIFIER_SECRET
vp exec wrangler secret put RATE_LIMIT_SECRET
vp exec wrangler secret put ENCRYPTION_SECRETS
vp exec wrangler secret put GOOGLE_CLIENT_ID
vp exec wrangler secret put GOOGLE_CLIENT_SECRET
vp exec wrangler secret put GITHUB_CLIENT_ID
vp exec wrangler secret put GITHUB_CLIENT_SECRET
vp exec wrangler secret put TWITTER_CLIENT_ID
vp exec wrangler secret put TWITTER_CLIENT_SECRET
```

`ENCRYPTION_SECRETS` is versioned symmetric secret material for the encrypted user profile envelope. Each value must
be 32 random bytes encoded as canonical base64url without padding. Generate each value from a cryptographically secure
random source, such as `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`.

```json
{ "active": "v1", "secrets": { "v1": "<base64url of 32 independent random bytes>" } }
```

The provider pairs are:

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`
- `TWITTER_CLIENT_ID` and `TWITTER_CLIENT_SECRET`

Register both the production and staging callback origins with each enabled provider.

Better Auth owns ES256 signing and JWKS persistence. Do not configure a separate signing secret.

## Cloudflare Workers Builds

Connect the repository to the existing `triad-auth` Worker and configure:

| Setting                            | Value                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| Production branch                  | `prod`                                                                                         |
| Builds for non-production branches | Enabled                                                                                        |
| Build command                      | `./node_modules/.bin/vp run check && git diff --exit-code && ./node_modules/.bin/vp run build` |
| Deploy command                     | `./node_modules/.bin/vp run deploy`                                                            |
| Non-production deploy command      | `if [ "$WORKERS_CI_BRANCH" = main ]; then ./node_modules/.bin/vp run deploy:staging; fi`       |
| Root directory                     | `/`                                                                                            |

Cloudflare runs the non-production command for every non-production branch. The branch guard uploads a version only
for `main`, so pull-request branches perform no deployment and receive no preview version.

The `prod` deployment uses the production `AUTH_ORIGIN` from `wrangler.toml`. The `main` command overrides that binding
only for its preview version and moves the stable `staging` alias to the new version.

D1 migrations are intentionally separate from Workers Builds. Apply each new checked-in migration with `vp run db:migrate` before deploying code that requires it. Cloudflare's automatically managed Workers Builds token does not include D1 write permission.

## Manual deployment

Run the required checks and build first:

```sh
vp run check
vp run build
```

Then deploy the current checkout as production or upload it as staging:

```sh
vp run deploy
vp run deploy:staging
```

After the production deployment is active, remove pre-HMAC limiter rows and scrub historical session metadata:

```sh
vp exec wrangler d1 execute DB --remote --command \
  'delete from "rateLimit"; update "session" set "ipAddress" = null, "userAgent" = null where "ipAddress" is not null or "userAgent" is not null'
```

Confirm the cleanup without selecting private values:

```sh
vp exec wrangler d1 execute DB --remote --command \
  'select (select count(*) from "rateLimit") as rate_limit_rows, (select count(*) from "session" where "ipAddress" is not null or "userAgent" is not null) as metadata_sessions'
```
