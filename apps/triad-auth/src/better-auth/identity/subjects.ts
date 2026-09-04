import { toHex } from "viem";

export const SOCIAL_PROVIDERS = ["google", "github", "twitter"] as const;

export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];
export type AuthenticationProvider = SocialProvider | "ethereum" | "passkey";

export function isSocialProvider(value: unknown): value is SocialProvider {
  return SOCIAL_PROVIDERS.some((provider) => provider === value);
}

const encoder = new TextEncoder();

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);

  return toHex(new Uint8Array(digest)).slice(2);
}

export async function ethereumUpstreamId(address: string): Promise<string> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error("Invalid Ethereum address");
  }

  return sha256Hex(address.toLowerCase());
}

export async function passkeyUpstreamId(publicKey: Uint8Array): Promise<string> {
  if (publicKey.length === 0) {
    throw new Error("Passkey must contain a canonical COSE public key");
  }

  return sha256Hex(publicKey);
}

async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(value));

  return toHex(new Uint8Array(digest)).slice(2);
}

export async function providerSubject(
  secret: string,
  provider: AuthenticationProvider,
  upstreamId: string,
): Promise<string> {
  const digest = await hmacSha256(secret, `provider-sub\0${provider}:${upstreamId}`);

  return `pid_${provider}_${digest}`;
}

export async function accountSubject(
  secret: string,
  provider: AuthenticationProvider,
  upstreamId: string,
): Promise<string> {
  const digest = await hmacSha256(secret, `account-sub\0${provider}:${upstreamId}`);

  return `acc_${digest}`;
}

export async function pairwiseSubject(
  secret: string,
  accountSub: string,
  clientId: string,
): Promise<string> {
  const digest = await hmacSha256(secret, `pairwise-sub\0${accountSub}\0${clientId}`);

  return `pws_${digest}`;
}
