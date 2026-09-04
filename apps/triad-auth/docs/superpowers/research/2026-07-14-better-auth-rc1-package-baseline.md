# Better Auth 1.7.0-rc.1 Package Baseline

## Installed Packages

| Package                       | Version      | Role                                                     |
| ----------------------------- | ------------ | -------------------------------------------------------- |
| `better-auth`                 | `1.7.0-rc.1` | Core auth factory, built-in database support, JWT plugin |
| `@better-auth/oauth-provider` | `1.7.0-rc.1` | OAuth/OIDC authorization server                          |
| `@better-auth/cimd`           | `1.7.0-rc.1` | Client ID Metadata Documents                             |
| `auth`                        | `1.7.0-rc.1` | `auth` and `better-auth` schema CLI binaries             |

## Verified Public Imports

```ts
import { cimd } from "@better-auth/cimd";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { jwt } from "better-auth/plugins";
```

`BetterAuthOptions["database"]` accepts the Cloudflare `D1Database` binding directly. Triad does not use Drizzle, a Kysely dialect package, or Miniflare.

## CLI Contract

The RC.1 CLI package is `auth@1.7.0-rc.1`. It exposes both `auth` and `better-auth` binaries. There is no `@better-auth/cli@1.7.0-rc.1` release.

## Scope Boundary

This baseline verifies package availability and public entry points only. It does not assert OAuth Provider option names, CIMD option names, extension APIs, schema contents, or runtime protocol behavior. Those contracts belong to the compatibility-hooks workstream.
