import { base64UrlDecode } from "../utils";
import { signPrfWallet } from "../better-auth/wallet/signatures";
import type { WalletProfileId } from "../better-auth/wallet/profiles";

export function passkeyPrfResult(extensionResults: unknown): Uint8Array<ArrayBuffer> {
  const prf =
    typeof extensionResults === "object" && extensionResults !== null
      ? Reflect.get(extensionResults, "prf")
      : undefined;
  const results = typeof prf === "object" && prf !== null ? Reflect.get(prf, "results") : undefined;
  const first =
    typeof results === "object" && results !== null ? Reflect.get(results, "first") : undefined;
  if (!(first instanceof ArrayBuffer) || first.byteLength !== 32) {
    throw new Error("This passkey did not produce the required PRF result");
  }

  return new Uint8Array(first);
}

export function walletPrfExtension(salt: string): AuthenticationExtensionsClientInputs {
  const bytes = base64UrlDecode(salt);
  if (bytes.length !== 32) {
    throw new Error("Triad returned an invalid PRF salt");
  }

  return { prf: { eval: { first: bytes } } };
}

export function signWithPrfWallet(
  prfRoot: Uint8Array<ArrayBuffer>,
  walletProfile: WalletProfileId,
  accountIndex: number,
  message: string,
) {
  return signPrfWallet(prfRoot, walletProfile, accountIndex, message);
}
