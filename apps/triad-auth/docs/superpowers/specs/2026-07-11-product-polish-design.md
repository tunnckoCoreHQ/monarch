# Product polish design

## Goal

Polish Triad's public copy and transaction UI, simplify opaque identifiers, and bring the codebase in line with `AGENTS.md` without changing the core identity model.

## Product language

- Lead with "Identity, that works" and explain global continuity versus app-scoped privacy directly.
- Replace internal phrases such as "broker upstream" with user-facing actions: choose a provider, approve a connection, and verify a token.
- Explain device authorization as pairing or authorizing another device through a browser.
- Make the footer a compact set of real links.
- Remove `ME` from the primary navigation; expose the destination as `ACCOUNT` in the footer.

## Visual system

- Replace the olive-yellow signal with a coral-orange signal while retaining the black-box switchboard structure.
- Keep sharp rules, the existing typography, and the current responsive composition.
- Separate the account sign-out action from the authorized-app panel with explicit spacing.
- Remove programmatic focus from successful verified-result headings. Errors continue to receive focus.

## Consent

- Use `CHECK THE CONNECTION` as the eyebrow and `IDENTITY HANDSHAKE` as the main title.
- The core `openid` disclosure is always shared and remains a static list of the three identity claims.
- Each requested profile scope is shown as a checked, disabled switch. The client request makes those claims mandatory for the transaction.
- Approval accepts the complete request or cancels it; consent does not alter the requested scope set.
- Device authorization uses the same mandatory-request display so browser and device flows have one privacy contract.
- Copy describes what the person is sharing and avoids implementation guidance meant for client developers.

## Demo

- Render providers in a native select control so the control reads as configuration rather than a submit button.
- Preserve optional claim request controls; clients request them through the `scope` authorization parameter or device authorization form field.
- Rename successful profile sections to `SHARED CLAIMS`.

## Identifiers

- Derive identifier bodies from the first 128 bits of HMAC-SHA-256 and encode them as 32 lowercase hexadecimal characters.
- Pairwise subjects use `ps_<hex>`.
- Provider subjects use `pid_<provider>_<hex>`; `pid` means provider identity and replaces the cryptic `prv` prefix.
- Existing records do not require migration because these values are derived when a token is issued. New tokens intentionally use the new format.

## OpenID discovery

- Keep `subject_types_supported: ["pairwise"]`; `pairwise` is the standard OpenID Connect subject type represented by Triad's `sub` and `pairwise_sub`.
- Keep the custom request scope `avatar` and standard result claim `picture`. Discovery correctly lists request vocabulary under `scopes_supported` and token vocabulary under `claims_supported`.
- Document this scope-to-claim mapping for clarity.

## Code quality

- Add repository formatting commands and apply them across source, tests, documentation, and configuration.
- Extract repeated scope-selection validation into a focused typed helper.
- Extract page behavior from large Astro templates where it materially improves separation without introducing framework abstractions.
- Keep route and provider refactors focused on touched behavior; avoid broad architectural churn.

## Verification

- Add unit and route tests for new identifier formats and partial scope grants.
- Run the complete typecheck, build, test, formatting, and Wrangler dry-run checks.
- Validate desktop and mobile landing, demo, consent, callback, and account layouts in a real browser.
- Deploy only after all checks pass, then smoke-test live providers and discovery.
