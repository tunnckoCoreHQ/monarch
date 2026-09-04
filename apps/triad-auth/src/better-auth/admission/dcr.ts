import type { OAuthOptions, Scope } from "@better-auth/oauth-provider";

export type PublicDcrOptions = Partial<OAuthOptions<Scope[]>>;

export function createPublicDcrOptions() {
  return {
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationRequirePKCE: true,
    grantTypes: ["authorization_code"],
  } satisfies PublicDcrOptions;
}
