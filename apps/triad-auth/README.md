# Triad Auth

This branch rebuilds Triad as a Better Auth OAuth/OIDC authorization server. The existing custom implementation remains preserved on `main` and continues to use its original Worker and D1 database.

The visual application is retained as the product baseline: the landing page, demo, consent, account, and device surfaces keep Triad's typography, layout, and interaction language while their backend integration is replaced.

The authorization-server design is documented in `docs/superpowers/specs/2026-07-14-better-auth-authorization-server-design.md`. Numbered implementation plans under `docs/superpowers/plans/` define one focused worktree each.

The canonical domain language is defined in [`CONTEXT.md`](./CONTEXT.md). Architectural decisions are recorded in [`docs/adr/`](./docs/adr/).

## Local commands

```sh
vp install
vp run dev
vp run check
vp run build
```

## Deployment

Triad runs as two Cloudflare Workers with two D1 databases. Pull requests merge into `master`, which Workers Builds deploys to `triad-auth-nightly` at `https://triad-auth-nightly.wgw.lol`. Moving the `release/triad-auth` branch forward deploys `triad-auth` at `https://triad-auth.wgw.lol`. Other branches do not deploy.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full flow, first-time setup, and secrets.

## Data and identity boundaries

Triad derives provider and pairwise subjects from the dedicated `IDENTIFIER_SECRET`. Passkey account subjects are SHA-256 digests of their immutable canonical usernames. The OIDC discovery document advertises pairwise subjects only. Provider accounts remain separate even when their profile emails match.

The optional provider profile fields (`email`, `email_verified`, `handle`, `name`, and `avatar_url`) are stored only inside the versioned user `encryptedData` envelope. `ENCRYPTION_SECRETS` supplies its encryption. Better Auth-managed wallet, passkey, session, OAuth, and JWKS records remain protocol state. Better Auth owns ES256 signing and persists its JWKS; Triad does not accept a separate signing key secret. Upstream provider access, refresh, and ID tokens are removed before account persistence.

Social provider account records keep Better Auth's verified issuer and immutable upstream account ID so later sign-ins resolve the same account. Those values are not issued to downstream clients; Triad issues derived identity claims.

Ethereum identities use the SHA-256 digest of the lowercased address as their immutable upstream input, producing `pid_ethereum_*` and `acc_*` subjects without exposing the address by default. A client can request the explicit `wallet` scope to receive it. Passkey identities require a user-verified Identity Passkey and support every WebAuthn public-key algorithm accepted by SimpleWebAuthn. Their first registration combines a user-selected name with a six-character CUID2 suffix. The SHA-256 digest of that immutable canonical username produces the `acc_*` subject and WebAuthn user handle, while the SHA-256 digest of the canonical COSE public key remains the input for `pid_passkey_*`. Triad stores the canonical username as the encrypted profile handle and makes it available as `preferred_username` only through the consented `handle` scope. The credential ID, public JWK, and registered COSE_Key are available only through the consented `cred`, `pubkey`, and `cosekey` claims. The `cosekey` claim encodes the registered COSE_Key as base64url. Better Auth retains wallet addresses, credential IDs, and public keys in the credential tables it uses to authenticate them. Triad also retains the canonical passkey username and its account mapping for uniqueness. Google, GitHub, Twitter, and Passkey Identity Sources may attach any user-verified Passkey. An Identity Passkey or Attached Passkey becomes a Wallet Passkey only after it proves Wallet Capability. An EVM Identity Source cannot attach Passkeys or derive a PRF wallet.
The physical `user` table keeps Better Auth's required structural columns, but the user create hook replaces the core `name`, `email`, `emailVerified`, and `image` values with an empty name, an account-subject placeholder email, `false`, and an empty image before persistence. No provider profile value is written to those columns.

Rate-limit buckets are HMAC-derived with `RATE_LIMIT_SECRET` from Better Auth's normalized IP-and-path key. D1 receives only the opaque digest, request count, and timestamp. Session rows retain Better Auth's generated request-metadata columns, but create and update hooks always persist `NULL` for `ipAddress` and `userAgent`.

The signed-in account page can delete the account. Deletion removes the profile envelope, sessions, provider account, device and wallet request records, consents, grants, and user-bound token records. Already issued short-lived JWTs may remain valid until expiry, and deletion does not remove data held by an upstream provider.

## Wallet authorization

A registered client starts a wallet request at `/wallet/authorize` with `client_id`, its exact registered `redirect_uri`, a state value of at least 16 characters, the message to approve, and a required `wallet_profile`. `namespace` defaults to `client` and accepts `account`, `client`, or `source`. `account_index` defaults to `0`. Raw derivation paths are not accepted. The supported profiles are `evm`, `solana`, `bitcoin-native-segwit-mainnet`, `bitcoin-native-segwit-testnet`, `bitcoin-taproot-mainnet`, and `bitcoin-taproot-testnet`. Bitcoin therefore always has an explicit address type and network.

Triad validates the client and redirect, requires an authenticated Triad Account, and lets the Account Holder choose a Wallet Passkey. Only Identity Passkeys and Attached Passkeys that have proved Wallet Capability are offered. The selected namespace uses the Account Subject, the exact Client Application's Pairwise Subject, or the Source Subject as the domain-separated PRF salt context. The PRF result becomes the Wallet Seed in the browser. The Wallet Profile and Account Index resolve the standard Derivation Path. EVM uses EIP-191, Solana uses Ed25519, and Bitcoin uses BIP-322 Simple. EVM `chain_id` defaults to `1`, is bound into the Signing Envelope, and does not change the path, key, or address. The Worker consumes the five-minute challenge once, verifies the exact selected stored Passkey assertion and Derived Wallet signature, and signs a short-lived Wallet Authorization Receipt with Triad's existing ES256 JWKS key. The receipt binds the Client Application audience, Pairwise Subject, request, wallet address, envelope hash, signature hash, namespace, profile, index, path, applicable Chain ID, and lifetime. Triad returns the complete Wallet Authorization Result in the registered redirect URI fragment.

Example request:

```text
https://triad-auth.wgw.lol/wallet/authorize?client_id=https%3A%2F%2Fclient.example%2Foauth.json&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&state=client-generated-state-1234&namespace=client&wallet_profile=evm&account_index=0&chain_id=1&message=Sign%20the%20client%20challenge
```

The callback fragment contains `state`, `triad_request_id`, `triad_address`, `triad_signature`, `triad_namespace`, `triad_namespace_subject`, `triad_wallet_profile`, `triad_account_index`, `triad_path`, an applicable `triad_chain_id`, the base64url-encoded `triad_message`, and `triad_receipt`. Clients must compare `state`, verify the ES256 receipt through Triad's published JWKS with their Client ID as audience, compare its hashes and fields with the result, verify the exact returned Signing Envelope with the returned Wallet Profile, and reject replayed request IDs.

Terms and the current data inventory are available at [`/terms`](/terms) and [`/privacy`](/privacy).

## Device authorization

Triad supports two device contracts through Better Auth's shared device-code and approval routes:

- First-party devices use Triad's origin as `client_id` and redeem `/device/token` for a Triad session.
- Registered OAuth clients request approved scopes and resources, then redeem `/oauth2/token` with the RFC 8628 device-code grant for OAuth tokens.
