import type { OAuthOptions, Scope } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin, HookEndpointContext } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";

import { isRecord } from "../../utils";

export type PublicDcrOptions = Partial<OAuthOptions<Scope[]>>;

export function createPublicDcrOptions() {
  return {
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationRequirePKCE: true,
    grantTypes: ["authorization_code"],
  } satisfies PublicDcrOptions;
}

export const publicDcrGuard = {
  id: "triad-public-dcr-guard",
  hooks: {
    before: [
      {
        matcher: (context: HookEndpointContext) => context.path === "/oauth2/register",
        handler: createAuthMiddleware(async (context) => {
          const method = isRecord(context.body)
            ? context.body.token_endpoint_auth_method
            : undefined;
          if (method === "none" || (await getSessionFromCtx(context))) {
            return;
          }

          throw new APIError("BAD_REQUEST", {
            error: "invalid_client_metadata",
            error_description:
              'unauthenticated registration requires token_endpoint_auth_method "none"',
          });
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;
