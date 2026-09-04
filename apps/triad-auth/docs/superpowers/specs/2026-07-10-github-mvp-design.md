# Triad GitHub MVP Design

## Goal

Ship a public, inspectable OAuth/OIDC broker on Cloudflare that uses GitHub as its only upstream identity provider. The MVP demonstrates authorization-code with mandatory S256 PKCE and device authorization end to end, while exposing both privacy-preserving app identity and deliberate global identity.

The deployment is an MVP, not a general-purpose production identity platform. It must nevertheless implement the protocol and browser safety properties required to avoid publishing an obviously unsafe authentication service.

## Product Boundary

The MVP includes:

- GitHub authentication only.
- OIDC discovery and ES256 JWKS.
- Authorization-code flow with mandatory S256 PKCE.
- Device authorization flow with polling controls.
- A built-in same-origin client that demonstrates both flows.
- Consent, device verification, and account surfaces in the existing Triad visual language.
- D1-backed clients, transactions, grants, sessions, and consent.
- A stable `workers.dev` deployment when authenticated deployment is available.

The MVP excludes:

- Google and X adapters or UI.
- Arbitrary or dynamic client registration.
- Cross-provider account linking.
- Email, names, avatars, or other profile claims.
- Provider access-token persistence.
- Refresh tokens and broker API access tokens.
- Administrative UI, account deletion, and automated signing-key rotation.

## Identity Contract

Each ID token carries three intentionally distinct identifiers:

- `sub`: the app-scoped pairwise subject. This is the standard OIDC subject and the privacy-preserving default a client should use.
- `pairwise_sub`: the same app-scoped value, included under an explicit name so the identity model is self-documenting.
- `provider_sub`: the global, namespaced GitHub identity in the form `github:<numeric-id>`. This is stable across Triad clients and permits deliberate cross-application continuity.
- `account_sub`: Triad's random broker-global account identifier. With one provider it maps one-to-one to a GitHub identity, but it does not reveal the raw GitHub ID.

Hashing the GitHub ID would not improve cross-client privacy because a stable global hash remains correlatable. Namespacing the provider's immutable numeric ID avoids collisions and makes the semantics honest. The consent UI explicitly says that the requesting client receives a global provider identifier and can correlate it across participating apps.

No email or mutable GitHub login is used as an identity key.

## Architecture

One Cloudflare Worker is the deployable unit:

- Hono owns protocol and JSON endpoints.
- Astro produces static UI assets served through the Worker assets binding.
- D1 is authoritative for one-time transactions, grants, sessions, clients, and consent.
- ES256 keys and application secrets are Worker secrets.
- The built-in demo is a registered `triad-demo` client with exact same-origin redirect URIs.

The source is split by responsibility where useful: provider exchange, protocol validation, session/CSRF handling, token issuance, data access, and route composition. This keeps security-sensitive units independently testable without unrelated refactoring.

## Authorization-Code Flow

1. The built-in demo generates a PKCE verifier/challenge and random client state in the browser, retaining the verifier and state in session storage.
2. `/authorize` validates the exact registered redirect URI, client, response type, provider, state, and S256 challenge before creating a short-lived consent ticket.
3. Consent displays the client and exact identifier disclosure. Approval is a CSRF-protected POST; denial is also a POST and redirects the OAuth error to the registered URI.
4. GitHub authorization uses a one-time, hashed upstream state.
5. The callback atomically consumes the state, exchanges the code, resolves GitHub's immutable numeric ID, creates a broker session, and issues a one-time authorization code.
6. The demo callback validates state and exchanges the code plus verifier at `/token`.
7. The demo verifies the returned ID token through the published JWKS and displays the claim semantics.

## Device Flow

1. The demo requests a device and user code for `triad-demo`.
2. The user opens the verification page and enters or confirms the code.
3. The page fetches the requesting client, then submits a CSRF-protected confirmation POST before GitHub authorization starts.
4. The callback atomically approves the pending grant.
5. The demo poller respects the advertised interval and handles `authorization_pending`, `slow_down`, expiry, denial, and one-time consumption.
6. The resulting ID token uses the same identity contract as the browser flow.

## Safety Baseline

These are protocol correctness requirements for the public MVP, not a broad hardening program:

- Exact redirect URI allowlists and no open redirects.
- Mandatory PKCE and adequate verifier/challenge validation.
- One-time hashed OAuth state, consent tickets, authorization codes, and device codes.
- CSRF tokens for state-changing browser actions plus same-origin checks where applicable.
- POST-only mutation; no device approval or session mutation from GET requests.
- Secure, HTTP-only, SameSite cookies in production and explicit logout.
- HTTPS issuer enforcement outside local development.
- Security headers including CSP, frame denial, MIME sniffing protection, referrer policy, and permissions policy.
- `Cache-Control: no-store` on protocol, account, consent, and token responses.
- Bounded request bodies and identifier lengths.
- Basic per-IP and per-code throttling on authorization, token, and device endpoints using Cloudflare/D1-compatible state.
- Generic provider errors to clients and structured server-side logs without tokens or secrets.
- Immediate disposal of GitHub access tokens after the user ID lookup.

## Configuration And Secrets

`.dev.vars.example` documents all local variables. `.dev.vars` remains ignored and contains the developer's values:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `SIGNING_PRIVATE_JWK`
- `PAIRWISE_SECRET`

Production deployment uploads those values through Wrangler secret commands. The issuer is a non-secret deployment variable set to the canonical stable HTTPS URL. No secret is emitted into Astro assets, logs, Git history, or generated deployment configuration.

The GitHub OAuth callback is `<issuer>/callback/github`.

## Deployment

The primary deployment uses authenticated Wrangler, a named D1 database, applied migrations, Worker secrets, and a stable `workers.dev` hostname. Deployment order is:

1. Build and test locally.
2. Create or resolve D1 and place its real ID in Wrangler configuration.
3. Apply remote migrations.
4. Upload secrets.
5. Deploy once to establish the hostname.
6. Set the canonical HTTPS issuer and GitHub callback, then deploy the final configuration.
7. Run live discovery, JWKS, static-page, security-header, and complete demo smoke checks.

An accountless Worker is acceptable only if it provides a stable hostname, persistent D1-compatible storage, and secret injection. An ephemeral preview cannot be the canonical OAuth issuer or callback and is not treated as a successful deployment.

## Testing And Acceptance

Automated tests cover:

- Pairwise and global identity semantics.
- Client and redirect validation.
- PKCE validation and one-time authorization-code consumption.
- OAuth state and consent-ticket consumption.
- Device pending, slowdown, approval, denial, expiry, and one-time exchange.
- CSRF rejection and security headers.
- GitHub provider exchange with mocked upstream responses.
- ID-token signature and claims against JWKS.
- Demo route and static build availability.

Required checks are dependency installation, TypeScript, Vitest, Astro production build, Wrangler dry-run, local Worker smoke tests, and live deployment smoke tests. Visual validation uses the available agent-browser workflow on desktop and mobile widths; no Playwright, Puppeteer, or direct browser automation is introduced.

The MVP is complete when the public URL loads, discovery and JWKS are valid, both built-in demo flows reach a verified ID token using GitHub, secrets remain uncommitted, all automated checks pass, and the repository documentation gives exact local and deployed setup instructions.
