# Worker-Safe CIMD Configuration

`@better-auth/cimd@1.7.0-rc.4` validates client IDs, public addresses, authentication methods, public keys, redirect URIs, response/grant types, origin-bound fields, a five-second timeout, and a 5 KiB streaming body limit.

RC.4 requires an application-supplied `fetchClientMetadataResource` transport and rejects followed redirects and non-200 responses. Triad's transport replaces the unsupported Workers `redirect: "error"` mode with `redirect: "manual"`; the package patch no longer carries redirect behavior.

RC.4's `mcp-2026-07-28` metadata profile requires nonempty `client_name` and `redirect_uris`. Triad does not add a separate client-name length limit. Its DNS and same-origin JWKS policy remains application configuration through `isMetadataDocumentUrlAllowed` and `originBoundFields`.

Triad no longer patches `@better-auth/cimd`. The package's current API and the application-supplied transport cover the required behavior.
