# Profile Claims and Device Demo Design

## Scope

Fix optional profile claim issuance, preserve the v1 browser/device composition, and add OAuth client device authorization beside the first-party session flow. Update the affected product and policy copy so the two device contracts remain explicit.

## Browser Flow

- Keep the account subject and provider subject authoritative and immutable. Treat Better Auth's email as an
  account-subject storage placeholder and keep its name and image values empty.
- Persist the provider profile snapshot only in the encrypted `encryptedData` envelope.
- Emit requested standard profile claims through OAuth Provider's first-party `customIdTokenClaims` and `customUserInfoClaims` hooks so package-owned claim guards cannot suppress them.
- Keep `pairwise_sub`, `account_sub`, and `provider_sub` in the extension claim path.
- Continue rejecting token issuance when a requested profile claim is unavailable or invalid.
- A clean staging database removes the transitional user whose profile columns are empty; no profile backfill or compatibility path is added.

## Device Demo

- Restore the v1 demo hierarchy and side-by-side browser/device bays without changing the established copy or visual language.
- Start the device flow through `POST /api/auth/device/code` with the current origin as `client_id`.
- Display the returned user code, verification URL, expiry, and polling state.
- Poll `POST /api/auth/device/token` at the server-provided interval and handle pending, slow-down, denial, expiry, cancellation, and success states.
- Reuse the existing `/device/verify/` approval page and Better Auth device plugin. Do not restore the removed custom device broker routes.
- Keep this first-party session flow when adding OAuth Provider device authorization.
- Register a separate public native OAuth client with the RFC 8628 grant, bind its scopes and resource at
  `/device/code`, and poll `/oauth2/token` for OAuth tokens.
- Present both device contracts as separate actions. Do not send a registered OAuth client to `/device/token` or
  a first-party Triad client to `/oauth2/token`.

## Schema and Deployment

- Generate one fresh `migrations/0001-initial.sql` migration from the finalized Better Auth configuration.
- Include encrypted `encryptedData` and the rate-limit table without the five legacy provider-profile columns or any
  transitional data-copy path.
- Use `triad-auth` for production resources and `triad-auth-staging` for staging resources.
- Preserve Worker secrets through dashboard renames and replace only the D1 databases.

## Verification

- Add integration coverage for actual OAuth Provider ID-token claim composition, not only direct extension calls.
- Cover identity-only and all optional disclosure scopes.
- Cover the device demo endpoint contract and polling state transitions.
- Run `vp run check` and `vp run build`.
- On staging, complete an all-scopes Google authorization flow and a device issue/approve/poll flow.
