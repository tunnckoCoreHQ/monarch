import { namehash, normalize } from "viem/ens";
import type { Hex } from "viem";

export interface ParsedName {
  name: string;
  node: Hex;
}

/** Normalizes a full ENS name. Returns null when the input cannot be a name. */
export function parseName(input: string): ParsedName | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0 || !trimmed.includes(".")) {
    return null;
  }

  try {
    const name = normalize(trimmed);
    return { name, node: namehash(name) };
  } catch {
    return null;
  }
}

/** Normalizes one label. Returns null when it is empty, has a dot, or fails normalization. */
export function parseLabel(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.includes(".")) {
    return null;
  }

  try {
    return normalize(trimmed);
  } catch {
    return null;
  }
}

export function formatExpiry(expiry: bigint): string {
  if (expiry === 0n) {
    return "unknown";
  }

  return new Date(Number(expiry) * 1000).toISOString().slice(0, 10);
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
