## Handoff — Triad audit conclusions

No code changes were made. `vp run check` passed formatting, lint, types, build, CSP generation, and Wrangler dry-run; the worktree remained clean.

### Confirmed product decisions

- `triad-auth-broker` is the correct current production Worker.
- The current Better Auth device flow is intentional:
  - It authenticates a device to Triad and returns a Triad session credential.
  - It is not OAuth/OIDC Device Authorization Grant.
  - It therefore does not belong in OAuth/OIDC discovery metadata.
- Later, Triad may support both device flows:
  - Triad session device authentication.
  - OAuth/OIDC device authorization for a downstream client/resource.
- The demo may always show Google, GitHub, and Twitter.
- Each upstream provider identity is a separate Triad account; provider linking is intentionally out of scope.
- RPC Wallets is a relic, not a product feature.

### Identity / OIDC

- Current standard OIDC `sub` is pairwise per exact client.
- Discovery should advertise:

  ```json
  ["pairwise"]
  ```

- Do not advertise both `public` and `pairwise` unless Triad later lets each registered client choose a persistent standard-`sub` mode.
- `account_sub` and `provider_sub` remain explicit global claims. Clients can choose which received claim to use internally; they do not need to choose a different standard `sub`.

### Data handling

- Current retained data is more than sessions and pseudonymous IDs:
  - Optional profile email, verification status, handle, name, avatar URL.
  - Session metadata.
  - Provider/account identifiers.
  - Consents, grants/tokens, device records, and client/resource metadata.
- Add account deletion.
- Add Terms and Privacy pages with an accurate retention/data inventory.
- Encrypt only the retained profile envelope:

  ```text
  email
  email_verified
  handle
  name
  avatar_url
  ```

- Use a dedicated, versioned profile-data encryption keyring. Do not reuse `IDENTIFIER_SECRET` or `BETTER_AUTH_SECRET`.
- Keep pseudonymous identity identifiers plaintext unless a later field-specific design warrants otherwise.
- Do not indiscriminately encrypt Better Auth-managed token/session/JWKS columns before confirming the package’s required storage/query semantics.

### Work to do

1. Set OIDC discovery subject type to `pairwise`.
2. Remove all RPC Wallets remnants:
   - Environment variable.
   - Resource policy/helpers.
   - Protected-resource metadata.
   - Tests and documentation.
3. Implement account deletion and define its exact cascade/retention behavior.
4. Add Terms and Privacy pages.
5. Encrypt retained profile claims using the dedicated keyring.
6. Add deferred platform hardening:
   - CSP, clickjacking protection, no-sniff, referrer policy, permissions policy, HSTS.
   - Rate limits for registration, authorization, device issue/inspect/poll, and token endpoints.
   - Startup validation for a strong `IDENTIFIER_SECRET`.
7. Later, add OAuth/OIDC device authorization as a separate companion capability when Better Auth OAuth Provider support—or a maintained patch—exists.

### Strengths observed

- Strong deterministic provider/account/pairwise identity model.
- Raw upstream OAuth tokens are stripped before storage.
- Short access/ID-token lifetimes, signed ES256 tokens, PKCE, state checking, and local JWKS verification are well represented.
- The visual system is coherent and distinct: identity ledgers, explicit consent, editorial hierarchy, and precise privacy language match the product direction.
