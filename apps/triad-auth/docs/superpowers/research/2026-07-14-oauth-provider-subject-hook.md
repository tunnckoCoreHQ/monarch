# OAuth Provider Exact-Client Subject Hook

`@better-auth/oauth-provider@1.7.0-rc.4` computes pairwise subjects from the first redirect URI host and rewrites introspection subjects at presentation time. Triad requires exact-client OIDC subjects and global access-token/introspection subjects.

The pnpm patch adds `resolveSubjectIdentifier` only after the built-in default is computed. The callback receives `userId`, exact `clientId`, `subjectType`, `defaultSubject`, and one of `id_token`, `userinfo`, or `logout_token`.

Without the callback, Better Auth's built-in subject behavior is unchanged. JWT access-token creation never calls the hook. Introspection returns the global token subject without pairwise rewriting.
