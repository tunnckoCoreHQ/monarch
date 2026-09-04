# Registration-Free Clients and Session Cleanup Design

## Goal

Make Triad easier to use during prototyping: browser clients identify themselves by redirect origin without registration, device clients use the same URL-origin identity directly, broker sessions last seven days, and the unused Astro session KV resource is removed. Correct the two mobile display headings without expanding test coverage.

## Client Identity

The canonical downstream `client_id` is an origin URL such as `https://example.com`. It contains a scheme and host, with no path, query, fragment, username, or password. Production clients require HTTPS. Local development permits `http://localhost` with an optional port.

Authorization requests derive the canonical client ID from `new URL(redirect_uri).origin`. The request may omit `client_id`. If it supplies `client_id`, that value must exactly equal the derived origin. This keeps existing explicit clients understandable while allowing Shoo-style links that provide only a callback.

The redirect URI may use any path on that origin. Triad no longer requires an exact pre-registered callback path. PKCE remains mandatory and authorization codes remain bound to the canonical client ID, exact redirect URI, and verifier. The token exchange must submit the same exact redirect URI and either submit the canonical client ID or let Triad derive it from that URI.

Device authorization has no redirect URI from which to derive an origin. `/device/code` therefore requires an origin-form `client_id`. A device client can use its project or application origin. This identifier is self-asserted: Triad does not claim that the device controls the domain. Consent and verification surfaces display the origin as a client identifier, not a verified domain.

The account-login client remains an internal Triad client rather than a downstream URL-origin client.

## Dynamic Client Records

Current transaction, grant, consent, and token tables reference `clients`. Triad keeps that relational structure and upserts a minimal client row when it first accepts a canonical origin:

- `client_id`: canonical origin.
- `name`: origin hostname, including the port for localhost when present.
- `redirect_uris`: an empty JSON array because callback trust is now derived from origin validation.
- `providers`: all provider adapter names; runtime credential availability remains authoritative.

Upserts must not overwrite an existing client name or historical consent relationship. Existing prototype client rows can remain; new browser and device requests no longer depend on pre-registration.

The pairwise subject and ID-token audience continue to use `client_id`. One origin therefore receives one stable pairwise identity across callback paths and across browser/device flows.

## Sessions

Triad's broker sessions remain in D1 `browser_sessions`. D1 is authoritative for logout, revocation, account deletion, expiry checks, and cleanup.

Both the D1 expiry and secure `triad_session` cookie `Max-Age` change from 30 days to seven days (`60 * 60 * 24 * 7`). No refresh or sliding extension is added.

Astro's Cloudflare adapter currently provisions `SESSION` KV because it installs a default Astro session driver whenever none is configured. Triad does not use Astro's session API. Configure a non-KV in-memory Astro session driver to suppress automatic binding generation, verify the generated Wrangler configuration has no `SESSION` binding, deploy that configuration, and delete the previously provisioned KV namespace. The in-memory driver is only an adapter opt-out; application authentication remains D1-backed.

## Interface Copy

The landing authorization example becomes registration-free and practical:

```text
?provider=github
&redirect_uri=https://example.com/oauth/callback
&code_challenge=...
&code_challenge_method=S256
```

Supporting copy states that Triad derives client identity from the callback origin and binds the authorization code to the exact callback and PKCE verifier.

Documentation removes registration-first language and explains the device-flow self-assertion caveat directly.

## Mobile Typography

The landing hero keeps `THAT WORKS.` as one phrase at narrow widths. The demo title keeps `ONE REQUEST.` and `THREE FLOWS.` as two intentional lines, never one word per line. Mobile-specific font sizes shrink enough for a 320px viewport, and phrase wrappers use non-wrapping behavior without causing horizontal overflow.

Desktop composition and explicit line breaks remain unchanged.

## Verification

Do not add new regression tests. Update existing fixtures or assertions only where the changed prototype contract makes them obsolete.

Required verification:

- Existing test suite.
- `vp run check`.
- Fresh `vp run build`.
- Generated Wrangler configuration contains D1 and Assets but no `SESSION` KV binding.
- Local browser and device authorization smoke checks use URL-origin client IDs.
- Production landing, demo, discovery, JWKS, provider list, browser flow, and device issuance smoke checks.
- Production broker session cookie reports a seven-day `Max-Age` after sign-in.
- The obsolete Cloudflare KV namespace is deleted only after a deployment without the binding succeeds.

## Non-Goals

- Domain ownership verification.
- Dynamic Client Registration metadata.
- Client secrets or confidential-client authentication.
- Exact callback-path registration.
- Moving broker sessions from D1 to KV.
- New test cases or a broader test-framework change.
