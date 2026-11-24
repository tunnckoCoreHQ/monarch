import { oauthDeviceAuthorization } from "@better-auth/oauth-provider";

import { FIRST_PARTY_DEVICE_CLIENT_ID } from "../../utils";

export const DEVICE_AUTHORIZATION_EXPIRES_IN = "10m" as const;
export const DEVICE_AUTHORIZATION_INTERVAL = "5s" as const;
export const DEVICE_AUTHORIZATION_VERIFICATION_URI = "/device/verify";

export function createTriadDeviceAuthorization() {
  return oauthDeviceAuthorization({
    expiresIn: DEVICE_AUTHORIZATION_EXPIRES_IN,
    interval: DEVICE_AUTHORIZATION_INTERVAL,
    verificationUri: DEVICE_AUTHORIZATION_VERIFICATION_URI,
    validateClient: (candidate) => candidate === FIRST_PARTY_DEVICE_CLIENT_ID,
  });
}

export type TriadDeviceAuthorizationPlugin = ReturnType<typeof createTriadDeviceAuthorization>;
