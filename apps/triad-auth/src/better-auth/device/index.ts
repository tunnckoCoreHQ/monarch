import { oauthDeviceAuthorization } from "@better-auth/oauth-provider";

import type { TriadEnv } from "../env";

export const DEVICE_AUTHORIZATION_EXPIRES_IN = "10m" as const;
export const DEVICE_AUTHORIZATION_INTERVAL = "5s" as const;
export const DEVICE_AUTHORIZATION_VERIFICATION_URI = "/device/verify";

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
