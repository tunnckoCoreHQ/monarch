import { siwe } from "better-auth/plugins";
import { isAddress, isHex, verifyMessage } from "viem";

import type { TriadEnv } from "../env";

export function createEthereumAuthentication(env: TriadEnv) {
  const origin = new URL(env.AUTH_ORIGIN);

  return siwe({
    domain: origin.host,
    emailDomainName: "identity.invalid",
    anonymous: true,
    getNonce: async () => crypto.randomUUID().replaceAll("-", ""),
    verifyMessage: async ({ message, signature, address }) => {
      if (!isAddress(address) || !isHex(signature)) {
        return false;
      }
      try {
        return await verifyMessage({
          address,
          message,
          signature,
        });
      } catch {
        return false;
      }
    },
  });
}
