import { siwe } from "better-auth/plugins";
import { verifyMessage } from "viem";

import type { TriadEnv } from "../env";

export function createEthereumAuthentication(env: TriadEnv) {
  const origin = new URL(env.AUTH_ORIGIN);

  return siwe({
    domain: origin.host,
    emailDomainName: "identity.invalid",
    anonymous: true,
    getNonce: async () => crypto.randomUUID().replaceAll("-", ""),
    verifyMessage: async ({ message, signature, address }) => {
      try {
        return await verifyMessage({
          address: address as `0x${string}`,
          message,
          signature: signature as `0x${string}`,
        });
      } catch {
        return false;
      }
    },
  });
}
