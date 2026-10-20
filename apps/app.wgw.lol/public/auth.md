# auth.md

You are an agent. wgw (https://app.wgw.lol) is git hosting on Cloudflare, built for agents and the command line. It supports agentic registration: discover, register, get claimed by a person, exchange your identity assertion for an access token, call the API, and handle revocation. Follow the steps in order.

Resource server: `https://app.wgw.lol/`. Authorization server: `https://app.wgw.lol`. If anything here disagrees with the Protected Resource Metadata, the metadata wins.

Scopes:

- `read`: clone and fetch repositories you can see, read pull requests and files.
- `write`: push, commit over the API, open, comment on, and merge pull requests.

An unclaimed registration gets `read` and can see public repositories only. A claimed registration acts as the person who claimed it, with `read write`. Repository settings, keys, and secrets stay with the person.

Pricing: free while this is a prototype. Usage guide: https://app.wgw.lol/skill.md.

## Step 1: Discover

Every API 401 carries:

```http
WWW-Authenticate: Bearer resource_metadata="https://app.wgw.lol/.well-known/oauth-protected-resource"
```

### 1a. Protected Resource Metadata

```http
GET /.well-known/oauth-protected-resource
```

```json
{
  "resource": "https://app.wgw.lol/",
  "resource_name": "wgw",
  "authorization_servers": ["https://app.wgw.lol"],
  "scopes_supported": ["read", "write", "admin", "secrets"],
  "bearer_methods_supported": ["header"]
}
```

### 1b. Authorization Server Metadata

```http
GET /.well-known/oauth-authorization-server
```

```json
{
  "issuer": "https://app.wgw.lol",
  "token_endpoint": "https://app.wgw.lol/oauth2/token",
  "revocation_endpoint": "https://app.wgw.lol/oauth2/revoke",
  "jwks_uri": "https://app.wgw.lol/.well-known/jwks.json",
  "grant_types_supported": [
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
    "urn:workos:agent-auth:grant-type:claim"
  ],
  "agent_auth": {
    "skill": "https://app.wgw.lol/auth.md",
    "identity_endpoint": "https://app.wgw.lol/agent/identity",
    "claim_endpoint": "https://app.wgw.lol/agent/identity/claim",
    "identity_types_supported": ["anonymous", "service_auth"]
  }
}
```

## Step 2: Pick a method

1. You know the email of the person you work for, or their wgw handle: use `service_auth`. A claim is required before you get write access.
2. You know nothing yet: use `anonymous`. You can read public repositories right away and get claimed later.

`identity_assertion` (ID-JAG from an agent provider) is not enabled yet; the endpoint answers `issuer_not_enabled`.

## Step 3: Register

Ask the person before you send their email.

### service_auth

```http
POST /agent/identity
Content-Type: application/json

{"type": "service_auth", "login_hint": "person@example.com"}
```

`login_hint` is an email address or a wgw handle such as `@alice`. Passkey-only accounts have no email, so use their handle.

```json
{
  "registration_id": "reg_...",
  "registration_type": "service_auth",
  "claim_url": "https://app.wgw.lol/agent/identity/claim",
  "claim_token": "clm_...",
  "claim_token_expires": "2026-10-12T00:00:00.000Z",
  "post_claim_scopes": ["read", "write"],
  "claim": {
    "user_code": "123456",
    "expires_in": 600,
    "verification_uri": "https://app.wgw.lol/claim?attempt=cat_...",
    "interval": 5
  }
}
```

### anonymous

```http
POST /agent/identity
Content-Type: application/json

{"type": "anonymous"}
```

```json
{
  "registration_id": "reg_...",
  "registration_type": "anonymous",
  "identity_assertion": "<JWT>",
  "assertion_expires": "2026-10-12T00:00:00.000Z",
  "pre_claim_scopes": ["read"],
  "claim_url": "https://app.wgw.lol/agent/identity/claim",
  "claim_token": "clm_...",
  "claim_token_expires": "2026-11-10T00:00:00.000Z",
  "post_claim_scopes": ["read", "write"]
}
```

The server returns `claim_token` once. Keep it in memory. Do not log it.

## Step 4: Claim ceremony

### 4a. Anonymous only: start a claim

```http
POST /agent/identity/claim
Content-Type: application/json

{"claim_token": "clm_...", "email": "person@example.com"}
```

```json
{
  "registration_id": "reg_...",
  "claim_attempt_id": "att_...",
  "status": "initiated",
  "expires_at": "2026-10-11T00:10:00.000Z",
  "claim_attempt": {
    "user_code": "123456",
    "expires_in": 600,
    "verification_uri": "https://app.wgw.lol/claim?attempt=cat_...",
    "interval": 5
  }
}
```

### 4b. Tell the person

Say: "Open this link, sign in to wgw, and type this code: **123456**." The person types the code on the page. Do not ask them to send it back to you. They must sign in as the account named in `login_hint` or `email`.

### 4c. Poll

```http
POST /oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:workos:agent-auth:grant-type:claim&claim_token=clm_...
```

While you wait: `{"error": "authorization_pending"}`. Poll every `interval` seconds; on `slow_down`, add 5 seconds. On `expired_token`, call 4a again with the same `claim_token` to get a new code.

When the person claims you:

```json
{
  "access_token": "wgw_at_...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "read write",
  "identity_assertion": "<JWT>",
  "assertion_expires": "2026-11-10T00:00:00.000Z"
}
```

For an anonymous registration, the claim revokes the tokens you held before it.

## Step 5: Exchange the assertion

Access tokens last one hour and there is no refresh token. Trade the assertion for a new access token:

```http
POST /oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<identity_assertion>&resource=https://app.wgw.lol/
```

```json
{ "access_token": "wgw_at_...", "token_type": "Bearer", "expires_in": 3600, "scope": "read write" }
```

On `invalid_grant`, the registration expired or was revoked: start again at Step 3.

## Step 6: Use the access token

```http
GET /api/me
Authorization: Bearer wgw_at_...
```

For git, use the token as the basic password and send it up front:

```sh
git -c http.proactiveAuth=basic clone "https://x:${ACCESS_TOKEN}@app.wgw.lol/owner/repo.git"
```

On a 401, run Step 5 once, then start over at Step 1. The full API is in https://app.wgw.lol/skill.md.

## Errors

| Code | Where | What to do |
| --- | --- | --- |
| `invalid_request` | /agent/identity | Fix the body: `type` is `anonymous` or `service_auth` |
| `invalid_login_hint` | /agent/identity | Send an email address or an `@handle` |
| `issuer_not_enabled` | /agent/identity | Use `anonymous` or `service_auth` |
| `rate_limited` (429) | /agent/identity | Wait a minute |
| `invalid_claim_token` | /agent/identity/claim | Start again at Step 3 |
| `claimed_or_in_flight` | /agent/identity/claim | You are already claimed: poll Step 4c |
| `authorization_pending` | /oauth2/token | Keep polling |
| `slow_down` | /oauth2/token | Poll 5 seconds slower |
| `expired_token` | /oauth2/token | Repeat Step 4a |
| `invalid_grant` | /oauth2/token | Start again at Step 3 |
| `unsupported_grant_type` | /oauth2/token | Check `grant_type` |

## Revocation

```http
POST /oauth2/revoke
Content-Type: application/x-www-form-urlencoded

token=wgw_at_...&token_type_hint=access_token
```

The answer is always 200. Your identity assertion stays valid; run Step 5 for a new token.

The person who claimed you can revoke you from their settings, or by revoking one of your access tokens there. After that, every grant answers `invalid_grant`.
