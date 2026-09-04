# Triad Better Auth Authorization Server Refactor

**Status:** Agreed design direction. This document describes intent and protocol shape, not an implementation plan.

## Intent

Triad becomes a full OAuth/OIDC authorization server built on Better Auth, not only an identity broker. Google, GitHub, and Twitter remain upstream identity providers; applications and MCP servers trust tokens issued by Triad.

Better Auth owns users, sessions, OAuth grants, consent records, clients, access and refresh tokens, DCR, CIMD, discovery, introspection, revocation, and JWKS. Triad remains the policy layer that defines identity derivation, provider separation, client admission, resource audiences, claims, consent presentation, and upstream-token disposal.

The refactor targets Better Auth `1.7.x`, initially the release candidate with `@better-auth/oauth-provider`, `@better-auth/cimd`, and JWT support. Small temporary package patches are acceptable when they are generic enough to propose upstream. Triad will not maintain a parallel custom authorization server.

Backward compatibility is not required.

## Clean Branch Boundary

`main` preserves the deployed custom authorization server. The `triad-better-auth` branch is a replacement implementation, not a side-by-side extension of that server.

The Better Auth branch retains the complete visual application: Astro pages, the landing page, demo surfaces, Shell, fonts, styles, browser assets, and public assets. Those files define the product's visual and interaction language. Their protocol integration may change, but the redesign must not discard or replace the established presentation.

The branch does not retain the custom authorization-server modules, routes, migrations, backend-only scripts, or tests. New implementation work starts from the clean base commit and adds only Better Auth behavior and tests. Canonical files such as `src/index.ts`, `wrangler.toml`, `.dev.vars.example`, `migrations/`, and package scripts belong solely to the replacement Worker on this branch.

The replacement uses Better Auth's built-in Cloudflare D1 support directly with the `D1Database` binding. It does not add Drizzle ORM, Drizzle Kit, or Miniflare. Better Auth generates the fresh schema, and Wrangler applies it to local and remote D1 databases.

## Identity Contract

Every upstream provider account is a separate Triad account. Upstream provider accounts are separate Better-Auth users. Matching emails never link Google, GitHub, or Twitter identities.

Triad retains three deterministic identity levels:

```text
provider_sub = HMAC(identifier_secret, "provider-sub\0" + provider + ":" + upstream_id)

account_sub = HMAC(identifier_secret, "account-sub\0" + provider + ":" + upstream_id)

pairwise_sub = HMAC(identifier_secret, "pairwise-sub\0" + account_sub + "\0" + exact_client_id)
```

Their meanings are:

| Identifier     | Boundary                                                   |
| -------------- | ---------------------------------------------------------- |
| `provider_sub` | One immutable upstream provider account across all clients |
| `account_sub`  | One global Triad account across all clients                |
| `pairwise_sub` | One Triad account inside one exact OAuth `client_id`       |

Deletion followed by the same upstream login recreates the same three identifiers.

Better Auth stores the identity as:

```text
account.accountId = provider_sub
user.id           = account_sub
user.name         = ""
user.email        = account_sub + "@identity.invalid"
user.emailVerified = false
user.image        = ""
user.provider     = google | github | twitter
user.providerSub  = provider_sub
```

The synthetic email satisfies Better Auth's required unique email field. It is derived from `account_sub`, but it is
never exposed as a profile claim, used for email delivery, or used to derive identity. A real upstream email remains
optional profile data and never participates in account lookup.

Better Auth account linking is disabled, implicit linking is disabled, and trusted providers are empty. Provider profile mapping converts the raw upstream ID before persistence. Account create and update hooks remove upstream access tokens, refresh tokens, ID tokens, token expiry data, and account-cookie token material.

Triad reuses the existing Google, GitHub, and Twitter client IDs and client secrets unchanged. The values remain uncommitted and are uploaded as secrets to the new Worker under their existing binding names. Upstream callback URLs are not changed during implementation. After the new Worker has stable callback endpoints, the deployment handoff reports the exact URLs and waits for the operator to update the existing provider registrations before live provider verification.

## Token Contract

Triad deliberately gives clients and resources access to all three identity levels. Pairwise identity is a selectable application namespace, not a promise that global correlation is impossible.

An ID token uses the client-pairwise identity as its standard subject:

```text
sub          = pairwise_sub
pairwise_sub = pairwise_sub
account_sub  = Better Auth user.id
provider_sub = Better Auth user.providerSub
aud          = exact client_id
```

A JWT access token uses the global Triad account as its standard subject:

```text
sub          = Better Auth user.id
account_sub  = Better Auth user.id
pairwise_sub = HMAC(account_sub, exact client_id)
provider_sub = Better Auth user.providerSub
client_id    = requesting client
aud          = exact OAuth resource URI
```

The resource server can intentionally key data by `pairwise_sub`, `provider_sub`, or `account_sub`. Access tokens are short-lived and audience-bound. Refresh tokens are opaque, rotated, client-bound, resource-bound, and revocable. Already-issued JWT access tokens remain valid until expiry.

Better Auth already uses its global user ID as JWT access-token `sub`. Triad preserves that behavior. A narrow `resolveSubjectIdentifier` option is needed only to derive OIDC-facing pairwise subjects from the exact `client_id` rather than the first redirect URI sector. It must keep ID token, UserInfo, refresh issuance, and logout subjects consistent. Access-token introspection must continue reporting the global access-token subject rather than replacing it with the OIDC pairwise subject. The option should be proposed upstream to Better Auth.

## Client Admission

Triad has no developer dashboard, manually approved client registry, or app marketplace. Client admission is automatic.

### CIMD

CIMD is the primary zero-touch mechanism. The HTTPS metadata-document URL is the `client_id`.

```text
1. Client sends an authorization request with its CIMD URL as client_id.
2. Triad fetches and validates the document.
3. The document's client_id must exactly equal its URL.
4. Triad validates the exact redirect URI and client authentication method.
5. Better Auth may persist a bounded refreshable cache; this is not operator registration.
```

Public CIMD clients use `token_endpoint_auth_method=none` and mandatory S256 PKCE. Confidential CIMD clients use `private_key_jwt` with a public key from `jwks` or `jwks_uri`; PKCE remains mandatory.

### Dynamic Client Registration

Open DCR is the fallback for public clients that cannot host a CIMD document.

```text
1. Client POSTs protocol metadata to the registration endpoint.
2. Triad validates redirect URIs and allows only public authorization-code clients.
3. Triad generates a random client_id and stores minimal protocol metadata.
4. The client uses that client_id with mandatory S256 PKCE.
```

Unauthenticated DCR does not issue client secrets. Stored records contain only what later authorization requests require: client ID, exact redirect URIs, grant and response types, authentication method, creation time, and activity time. They are protocol state, not product accounts.

Confidential clients use CIMD with `private_key_jwt`. Protected DCR may be considered later but is not required initially. Pre-registered clients are not part of the product.

An HTTP `Origin` header is not a client identity and is not used to derive DCR client IDs. Server, native, CLI, and MCP clients may have no trustworthy web origin, and Triad must retain exact redirect metadata for later requests.

### Device Authorization

Triad mounts Better Auth's `deviceAuthorization()` and OAuth Provider's `deviceCodeGrant()` together. They share device-code issuance and browser approval while preserving two redemption contracts.

- A first-party client uses Triad's origin as `client_id` and redeems `/device/token` for a Better Auth session.
- A registered OAuth client binds scopes and resources, then redeems `/oauth2/token` for OAuth Provider tokens.

```text
1. A first-party or registered client requests device and user codes from `/device/code`.
2. Triad accepts its exact first-party client ID or resolves and authenticates the registered OAuth client.
3. The user opens the verification page and authenticates through Better Auth.
4. The approval page identifies the client, result type, resources, scopes, and user code.
5. The first-party client polls `/device/token`; the registered client polls `/oauth2/token`.
6. Approval returns either a Triad session or scoped OAuth tokens according to that client contract.
```

The shared device record stores the generated device code, normalized user code, polling state, client, scopes, resources, expiry, and approval identity. The OAuth companion authenticates registered clients, advertises the device endpoint and grant, and issues tokens through OAuth Provider's existing policy. Unknown client IDs are rejected instead of falling through to first-party behavior.

## Protected Resource Flow

Triad publishes protected-resource metadata for its demo resource and issues tokens only for recognized resources.
The resource is distinct from the client: the client requests authorization, while the resource receives the token.

```text
1. A resource publishes RFC 9728 protected-resource metadata naming Triad.
2. An OAuth client discovers Triad's authorization metadata.
3. The client uses CIMD, or public DCR as a fallback.
4. The client starts authorization with S256 PKCE and the exact resource URI.
5. Triad authenticates the user through the selected upstream provider.
6. Consent identifies the client, resource, and requested scopes.
7. Triad returns an authorization code to the exact registered redirect URI.
8. The client exchanges the code for an audience-bound access token and optional ID token.
9. The resource verifies signature, issuer, expiry, audience, client, and scopes on every request.
```

## Better Auth Policy And Patches

The intended integration uses supported Better Auth hooks wherever possible:

- Provider profile mapping for opaque provider and account IDs.
- User create hooks for account-subject IDs, empty core profile values, and synthetic emails.
- Account hooks to strip upstream tokens.
- Custom ID-token, UserInfo, and access-token claims for Triad identifiers.
- OAuth resource policies for audience, scopes, TTL, and signing.
- Global rate limiting for authorization, registration, and token endpoints.

The initial patch surface should remain narrow:

- Add a generic `resolveSubjectIdentifier({ userId, clientId, subjectType, defaultSubject })` OAuth Provider option.
- Keep JWT access-token and introspection `sub` global while applying the resolver only to OIDC-facing subjects.
- Constrain open DCR to public clients and reject anonymous client-secret issuance.

Better Auth RC.4 supplies the current CIMD transport, redirect, metadata-profile, and cache APIs. Triad configures those APIs directly and does not patch `@better-auth/cimd`. OAuth Provider's upstream `deviceCodeGrant()` supplies the registered-client RFC 8628 integration.

These changes should be covered by Triad integration tests and proposed upstream rather than developed into a custom protocol layer.

## Implementation Workstreams

Every workstream has one focused plan document, one feature branch, one worktree, one implementer, and one review gate. Feature worktrees branch from the latest reviewed prerequisite commit and merge only into `triad-better-auth`.

The serial foundation is:

1. Package baseline: install the complete Better Auth family at `1.7.0-rc.4`.
2. Compatibility hooks: patch only exact-client subjects and public DCR policy.
3. Platform foundation: add the direct D1 binding, environment contract, minimal Better Auth factory, Worker routing, and schema-generation commands.

After the platform foundation merges, these disjoint modules may run in parallel:

1. Deterministic identity and upstream-provider policy.
2. OIDC subjects, triple claims, JWT access tokens, and JWKS.
3. CIMD client admission.
4. Public DCR admission.
5. MCP resources and audience policy.
6. First-party and registered-client device authorization.
7. Better Auth integration for the preserved product and demo surfaces.

Serial integration then composes the reviewed modules, generates the fresh migration, verifies the complete local protocol, creates only the new D1 database and bindings, and deploys only the `triad-better-auth` Worker.

No inherited test is restored. Each workstream adds focused tests for its own new behavior. Pure policy tests run directly; database and full protocol verification use Better Auth's D1 integration and Wrangler's local D1 environment rather than a separate database abstraction or emulator dependency. Every workstream runs `vp run check` and `vp run build` before review.

## Deployment Isolation

The replacement Worker and D1 database are both named `triad-better-auth`. Its migrations are fresh and contain no migration path from the existing `triad-auth` database. The initial issuer is the new Workers hostname.

The branch must never deploy to `triad-auth-broker`, bind the existing `triad-auth` database, apply the old migrations, or alter the current Worker's secrets. Provider credentials are the only values intentionally reused, and they are uploaded separately to the new Worker.

The provider callback switch is a deployment gate, not an implementation prerequisite. The new Worker is deployed and its callback paths are confirmed first. The operator then updates Google, GitHub, and Twitter registrations to those paths. Live provider tests begin only after that handoff.

## Explicit Non-Goals

- Automatic or email-based provider linking.
- Explicit provider linking in the initial refactor.
- Manually pre-registering applications.
- A client-management dashboard or app directory.
- Migrating existing database rows, sessions, clients, or consents into the Better Auth schema.
- Treating upstream provider tokens as Triad access tokens.
