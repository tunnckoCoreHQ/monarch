import { init } from "@paralleldrive/cuid2";
import { hexToBytes } from "viem";

import { base64UrlEncode } from "../../utils";
import { sha256Hex } from "./subjects";

const BASE_USERNAME_PATTERN = /^[a-z0-9][a-z0-9-]{2,23}$/;
const CANONICAL_USERNAME_PATTERN = /^[a-z0-9][a-z0-9-]{2,23}_[a-z][a-z0-9]{5}$/;
export interface PasskeyUsernameGeneratorOptions {
  random?: () => number;
}

export function normalizePasskeyUsername(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Passkey username is required");
  }

  const username = value.trim().toLowerCase();
  if (!BASE_USERNAME_PATTERN.test(username)) {
    throw new Error("Passkey username must use 3 to 24 letters, numbers, or hyphens");
  }

  return username;
}

export function canonicalPasskeyUsername(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_USERNAME_PATTERN.test(value)) {
    throw new Error("Canonical passkey username is invalid");
  }

  return value;
}

export function createPasskeyUsernameGenerator(
  options: PasskeyUsernameGeneratorOptions = {},
): (username: string) => string {
  const createSuffix = init({
    length: 6,
    ...(options.random ? { random: options.random } : {}),
  });

  return (username) => `${normalizePasskeyUsername(username)}_${createSuffix()}`;
}

export async function passkeyAccountSubject(username: string): Promise<string> {
  const canonicalUsername = canonicalPasskeyUsername(username);

  return `acc_${await sha256Hex(canonicalUsername)}`;
}

export async function passkeyWebAuthnUserId(username: string): Promise<string> {
  const accountSub = await passkeyAccountSubject(username);

  return accountSubjectWebAuthnUserId(accountSub);
}

export function accountSubjectWebAuthnUserId(accountSub: string): string {
  if (!/^acc_[0-9a-f]{64}$/.test(accountSub)) {
    throw new Error("Triad account subject is invalid");
  }

  const accountDigest = accountSub.slice("acc_".length);

  return base64UrlEncode(hexToBytes(`0x${accountDigest}`));
}

export function passkeyDisplayName(username: string, createdAt = new Date()): string {
  const canonicalUsername = canonicalPasskeyUsername(username);
  const timestamp = createdAt.toISOString();

  return `${canonicalUsername} · ${timestamp.slice(0, 10)} ${timestamp.slice(11, 16)} UTC`;
}
