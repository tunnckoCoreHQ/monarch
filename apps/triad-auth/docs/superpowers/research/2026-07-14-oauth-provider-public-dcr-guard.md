# OAuth Provider Public DCR Guard

Open registration in `@better-auth/oauth-provider@1.7.0-rc.4` rejects anonymous `client_credentials` clients but otherwise permits confidential authentication methods and can issue a client secret.

Triad's cumulative pnpm patch requires an unauthenticated registration request to explicitly declare `token_endpoint_auth_method: "none"`. Session-backed and initial-access-token-backed registration keep Better Auth's confidential-client behavior.

Redirect URI, grants, response types, scopes, resources, and pairwise subject normalization remain application policy and are not implemented by this package guard.
