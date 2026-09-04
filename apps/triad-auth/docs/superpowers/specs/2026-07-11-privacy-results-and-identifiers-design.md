# Privacy, results, and identifiers design

## Goal

Make Triad's privacy defaults explicit, present mandatory disclosures without false controls, refine the verified-result hierarchy, and standardize every public subject as a stable keyed hexadecimal identifier.

This specification supersedes the consent-switch and identifier-format decisions in `2026-07-11-product-polish-design.md`.

## Scope

- Keep the demo provider and optional-scope configuration unchanged, including disabled claims unsupported by the selected provider.
- Simplify authorization disclosures on consent and device verification pages.
- Add a privacy-and-scopes argument to the landing page.
- Recompose the browser callback result and add broker-session sign-out.
- Change public subject prefixes and bodies, then clear prototype identity state instead of migrating old subjects.
- Extend `AGENTS.md` with the principles that produce Triad's current visual language.

## Consent disclosures

The consent page lists facts, not choices. The client has already selected the complete scope request, and the person can approve or cancel that request.

- Render `pairwise_sub`, `account_sub`, `provider_sub`, and every requested profile claim as identical three-part ledger rows: human label, protocol claim, and plain explanation.
- Remove checkbox inputs, switches, selected states, and disabled-control styling from authorization disclosures.
- Use the same renderer on browser consent and device verification so both flows communicate one authorization contract.
- Preserve the existing client, provider, approve, cancel, loading, failure, and recovery states.
- Keep the statement that approval shares every listed claim.

## Landing privacy section

Add one section between the identity ledger and provider band. It should make the default request concrete rather than relying on a generic privacy claim.

- Lead with the statement `ASK FOR LESS. REVEAL LESS.`
- Explain that `openid` alone returns opaque Triad subjects and no profile data.
- Show the default withheld data explicitly: raw provider user ID, email, handle, name, avatar, and provider access token.
- Show the optional client request scopes `email`, `handle`, `name`, and `avatar`, including their resulting claims.
- Explain that a client chooses its request and the person sees the exact mandatory list before approval.
- Reuse ledgers, rules, typography, and signal color rather than introducing card collections or decorative privacy badges.

## Verified callback result

The callback result should read in four phases: verification outcome, identity subjects, shared profile claims, then metadata and follow-up actions.

- Compose the loading title as two intentional lines: `CHECKING` and `SIGNED RESULT.`
- Keep the verified status header and three identity-subject rows inside the bordered result ledger.
- Render shared profile claims with the same row grid, coral protocol labels, value size, wrapping, and spacing as identity-subject rows.
- Keep `SHARED CLAIMS` as the section heading, but do not let it visually demote the values beneath it.
- End the bordered result after the final shared claim.
- Place issuer and expiry in a quieter metadata block below the result.
- Place `RUN ANOTHER FLOW` and `SIGN OUT` beside that metadata as follow-up actions.
- `SIGN OUT` loads the current broker session's CSRF token from `/api/me`, posts it to `/session/logout`, and returns to the demo in a signed-out state.
- While sign-out is active, disable the action and expose working, failure, and retryable states without disturbing the verified result.

## Stable subject formats

Keep domain-separated HMAC-SHA-256 derivation with `PAIRWISE_SECRET`. Expose the complete 256-bit result as 64 lowercase hexadecimal characters.

- Provider subject: `pid_<google|github|twitter>_<64 lowercase hex>` derived from a provider-subject domain and the provider plus raw provider user ID.
- Account subject: `acc_<64 lowercase hex>` derived from an account-subject domain and the provider plus raw provider user ID used to establish the account.
- Pairwise subject and OIDC `sub`: `pws_<64 lowercase hex>` derived from a pairwise-subject domain and the account subject plus client ID.
- Domain labels must differ so equal source values cannot produce equal identifiers across subject types.
- Values remain stable for the same identity context and change where their contract requires: provider, account, or client boundary.
- Raw provider IDs remain server-side and cannot be enumerated through an unkeyed digest.

## Prototype reset

Old account IDs are persisted and cannot be reformatted safely at presentation time. Because this deployment is a prototype, clear identity and transaction state instead of migrating it.

- Add a forward migration that deletes dependent transaction, consent, session, identity, and account rows in foreign-key-safe order.
- Preserve client registrations and deployment configuration.
- Applying the migration signs out existing browser sessions and requires users to authorize again.
- New account resolution creates only the new `acc_` format.

## Documentation

- Update source examples, landing examples, tests, and README format descriptions to the new prefixes and full hexadecimal bodies.
- Record that the Google authorization-code flow has been exercised successfully by the user.
- Keep Twitter described as implemented but disabled when credentials are absent.
- Preserve the existing historical specifications; this document states the decisions that replace them.

## Testing

- Add failing tests for the exact three identifier patterns before changing derivation.
- Test stability, domain separation, provider separation, and client-specific pairwise output.
- Test account resolution with the new secret input and account format.
- Test that authorization disclosure source contains no checkbox or switch construction.
- Test that callback profile claims use the identity ledger style and metadata/actions sit outside the result ledger.
- Test callback sign-out uses `/api/me`, the CSRF token, and `/session/logout`.
- Test the landing page contains the default-withheld privacy contract and optional scope mapping.
- Run `vp test`, `vp run check`, and `vp run build`.

## Deployment

1. Push each focused implementation commit immediately.
2. Apply the new D1 migration remotely.
3. Deploy the Worker and static assets.
4. Verify landing, discovery, JWKS, enabled providers, consent disclosure markup, and new identifier output.
5. Confirm the account reset produces a signed-out state until the next provider login.
