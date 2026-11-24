import { oauthDeviceAuthorization } from "@better-auth/oauth-provider";

import type { TriadEnv } from "../env";

export const DEVICE_AUTHORIZATION_EXPIRES_IN = "10m" as const;
export const DEVICE_AUTHORIZATION_INTERVAL = "5s" as const;
export const DEVICE_AUTHORIZATION_VERIFICATION_URI = "/device/verify";

// The first-party Triad device redeems its code on `/device/token`. A registered
// OAuth client never reaches this check: OAuth Provider admits it, and the
// client redeems its code on `/oauth2/token`.
export function createTriadDeviceAuthorization(env: Pick<TriadEnv, "AUTH_ORIGIN">) {
  const firstPartyClientId = new URL(env.AUTH_ORIGIN).origin;

  return oauthDeviceAuthorization({
    expiresIn: DEVICE_AUTHORIZATION_EXPIRES_IN,
    interval: DEVICE_AUTHORIZATION_INTERVAL,
    verificationUri: DEVICE_AUTHORIZATION_VERIFICATION_URI,
    validateClient: (candidate) => candidate === firstPartyClientId,
  });
}

export type TriadDeviceAuthorizationPlugin = ReturnType<typeof createTriadDeviceAuthorization>;
