import { deviceAuthorization } from "better-auth/plugins";

import type { TriadEnv } from "../env";

export const DEVICE_AUTHORIZATION_EXPIRES_IN = "10m" as const;
export const DEVICE_AUTHORIZATION_INTERVAL = "5s" as const;
export const DEVICE_AUTHORIZATION_VERIFICATION_URI = "/device/verify";

interface RegisteredClientRecord {
  registered: number;
}

async function isRegisteredOAuthClient(database: D1Database, clientId: string): Promise<boolean> {
  const client = await database
    .prepare(
      'select 1 as "registered" from "oauthClient" where "clientId" = ? and coalesce("disabled", 0) = 0 limit 1',
    )
    .bind(clientId)
    .first<RegisteredClientRecord>();

  return client?.registered === 1;
}

export function createTriadDeviceAuthorization(env: Pick<TriadEnv, "AUTH_ORIGIN" | "DB">) {
  const firstPartyClientId = new URL(env.AUTH_ORIGIN).origin;

  return deviceAuthorization({
    expiresIn: DEVICE_AUTHORIZATION_EXPIRES_IN,
    interval: DEVICE_AUTHORIZATION_INTERVAL,
    verificationUri: DEVICE_AUTHORIZATION_VERIFICATION_URI,
    validateClient: async (candidate) => {
      if (candidate === firstPartyClientId) {
        return true;
      }

      return isRegisteredOAuthClient(env.DB, candidate);
    },
  });
}

export type TriadDeviceAuthorizationPlugin = ReturnType<typeof createTriadDeviceAuthorization>;
