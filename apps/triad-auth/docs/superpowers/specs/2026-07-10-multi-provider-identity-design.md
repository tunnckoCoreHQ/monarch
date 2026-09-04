# Triad Multi-Provider Identity Design

## Goal

Turn the deployed GitHub MVP into provider-neutral Triad with Google, GitHub, and Twitter authentication. Keep both app-scoped and global identity claims, stop exposing raw upstream user IDs, and add explicit privacy-scoped profile claims. Reduce issued ID-token lifetime from ten minutes to five minutes.

## Provider Vocabulary

The canonical provider names are `google`, `github`, and `twitter` in routes, database rows, tokens, configuration, UI, and documentation. External Twitter OAuth endpoints remain hosted on `x.com` and `api.x.com`, but the product label and identifier prefix are always `twitter`, never `x`.

Provider callbacks are:

- `<ISSUER>/callback/google`
- `<ISSUER>/callback/github`
- `<ISSUER>/callback/twitter`

## Identity Contract

ID tokens retain three explicit identities:

- `sub` and `pairwise_sub`: the same HMAC-derived ID scoped to broker account and downstream client.
- `account_sub`: the random broker account ID, stable across Triad clients. Triad does not infer cross-provider links, so separate upstream identities remain separate broker accounts until explicit linking exists.
- `provider_sub`: an opaque provider-global ID stable across Triad clients.

`provider_sub` is derived as:

```text
prv_<provider>_<first 22 base64url characters of HMAC-SHA256(PAIRWISE_SECRET, "provider-sub\0<provider>:<immutable-id>")>
```

Examples begin `prv_google_`, `prv_github_`, or `prv_twitter_`. HMAC prevents offline enumeration of numeric provider IDs. The 22-character token represents at least 128 bits of output, enough to make collisions impractical while keeping claims compact. The raw provider ID remains only in the broker's identity mapping table and never appears in tokens, UI, URLs, or logs.

## Provider Adapters

### Google

Use OpenID Connect authorization code flow with a random nonce and Google's ID token. Verify Google's documented RS256 signature through its remote JWKS with JOSE, exact Google issuer, configured audience, expiry, and nonce before accepting immutable `sub`. Request `email` or `profile` upstream only when mapped client scopes require them.

### GitHub

Keep the current OAuth authorization code exchange and immutable numeric `/user.id` lookup. Request `user:email` only for the email scope and select only a verified primary address. Discard the access token and unrequested response fields immediately.

### Twitter

Use OAuth 2.0 authorization code with mandatory upstream S256 PKCE. Request only the minimum scopes and user fields required for `/2/users/me`, exchange through `https://api.x.com/2/oauth2/token`, and read immutable `data.id`. The adapter and product call the provider `twitter`; only external network hostnames use X branding.

All provider errors remain generic to clients and never log codes, tokens, or secrets.

## Authorization And Device Flows

Authorization requests require an allowed provider and persist that provider through consent, upstream transaction, callback, authorization code, and token issuance.

Device authorization requires a provider at issuance. A new `device_grants.provider` column stores the selected provider. Inspection returns the provider, and device verification can only continue with that stored value. This prevents the browser from changing the device client's provider choice.

The Worker exposes `/api/providers`, listing providers whose complete credential pair is configured. The built-in demo exposes one provider selector shared by browser and device starts, populated from that endpoint. Consent and verification pages render the persisted provider dynamically. Account sign-in offers enabled providers. Authorization and session routes reject an unconfigured provider before creating state or redirecting.

## Privacy-Scoped Claims

Identity-only authentication remains the default. Clients request claims with a space-delimited OAuth `scope` parameter on `/authorize` or in the form body sent to `/device/code`:

```text
openid email handle name avatar
```

`openid` is always required. The four profile scopes are independent, but every scope a client requests is mandatory for that transaction. Consent lists the exact requested disclosures and offers one approve or deny decision; it does not show editable checkboxes that imply the user can grant a subset. The token response returns the accepted scope string.

JWT claim mapping is:

- `email` -> `email` and `email_verified`
- `handle` -> `preferred_username`
- `name` -> `name`
- `avatar` -> `picture`

These claims are mutable profile data, never identity keys. They are omitted when not requested.

Provider capabilities are:

- Google: `email`, `name`, `avatar`
- GitHub: `email`, `handle`, `name`, `avatar`
- Twitter: `handle`, `name`, `avatar`

`/api/providers` returns enabled providers plus their supported scopes. A provider/scope mismatch returns `invalid_scope` before state or grant creation. If a provider supports a scope but the individual account does not supply its mandatory value, the transaction ends with `access_denied` and issues no code or token.

Upstream scope mapping remains minimal. Google adds `email` and/or `profile` only when needed. GitHub adds `user:email` only for email and selects the verified primary address; its authenticated user response supplies requested handle, name, and avatar fields. Twitter requests its base identity scopes and asks `/2/users/me` only for requested user fields. Provider access tokens and unused upstream fields are immediately discarded.

## Transient Claim Protection

The callback must carry requested profile values across the one-time authorization-code or device-token exchange. Triad encrypts the minimal claim JSON before placing it in D1. AES-GCM uses a random 96-bit IV and a key derived from `PAIRWISE_SECRET` with a distinct claims-encryption domain; row-specific additional authenticated data binds ciphertext to its authorization-code or device-grant hash.

A winning authorization-code or approved device-grant exchange atomically deletes its row before decrypting the claims. Abandoned profile ciphertext is exchangeable only until the authorization code's two-minute TTL or the device grant's ten-minute TTL. After expiry it remains encrypted and inaccessible to exchange, even if its row is still physically present. Bounded, sampled, traffic-driven cleanup physically deletes expired rows when later requests trigger it, so physical retention can exceed the protocol TTL when no later traffic arrives. Consents persist only scope names, never profile values.

## Token Lifetime

Signed ID tokens expire five minutes after issuance, and token responses advertise `expires_in: 300`. Authorization-code, device-code, consent, transaction, and browser-session lifetimes remain unchanged.

## UI And Copy

The landing page presents Triad as the product rather than a GitHub broker. Product-level explanations use “upstream provider” and “provider-global” language. Provider names appear only where users must select, inspect, or configure one.

The existing black-box switchboard design, typography, colors, spacing, responsive behavior, and accessibility patterns remain unchanged. Provider choice uses the existing square ruled control vocabulary, not new cards or provider-brand styling.

## Configuration

Add secrets:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `TWITTER_CLIENT_ID`
- `TWITTER_CLIENT_SECRET`

Keep existing GitHub and signing secrets. `.dev.vars.example`, the config checker, Wrangler comments, README, and tests cover all eight values without printing them.

Provider setup links documented in README:

- Google OAuth clients: `https://console.cloud.google.com/auth/clients`
- Google Auth Platform overview: `https://console.cloud.google.com/auth/overview`
- Twitter developer portal: `https://developer.x.com/en/portal/dashboard`
- Twitter projects and apps: `https://developer.x.com/en/portal/projects-and-apps`

## Data Migration

Add `migrations/0002_multi_provider.sql` for the already-deployed database. It invalidates short-lived consent, transaction, authorization-code, and device-grant rows so no in-flight grant can emit the old raw `provider_sub`; adds provider/scope/encrypted-claim columns needed by transactions and grants; and changes built-in client provider allowlists to `google`, `github`, and `twitter`. Fresh installations apply both migrations in order.

Existing raw GitHub identity mappings remain valid. Newly issued GitHub tokens switch from raw `github:<id>` claims to opaque `prv_github_*` claims; this is an intentional privacy change and downstream clients must treat it as an identifier migration.

## Testing And Deployment

Tests cover deterministic opaque provider subjects, provider separation, five-minute expiry, scope parsing and canonicalization, provider capability rejection, mandatory claim handling, encrypted transient claim round trips and tamper rejection, each adapter's minimal upstream scope and field mapping, state/nonce/PKCE verification, provider and scope persistence through code and device flows, dynamic consent disclosures, config validation, and migration behavior.

Deploy code and migration with existing GitHub credentials first. Google and Twitter appear in general product copy as supported providers, but transactional controls list only providers returned by `/api/providers`. Missing credentials produce a clear unavailable-provider response rather than a malformed upstream redirect. Upload new credential pairs and redeploy when supplied, then run one live flow per provider.
