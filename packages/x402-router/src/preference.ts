import { ROUTER_PREFERENCE_HEADER } from "./defaults";

/**
 * Upstream names to try first, per CAIP-2 namespace (`eip155`, `solana`) or full network
 * (`eip155:8453`). A full network beats its namespace.
 */
export type X402RouterPreference = Record<string, string[]>;

export function encodeRouterPreference(preference: X402RouterPreference) {
  return Object.entries(preference)
    .map(([key, names]) => `${key}=${names.join(",")}`)
    .join(";");
}

export function parseRouterPreference(value: string | null): X402RouterPreference {
  const preference: X402RouterPreference = Object.create(null);

  for (const part of value?.split(";") ?? []) {
    const [key, names] = part.split("=");

    if (key?.trim() && names) {
      preference[key.trim()] = names
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    }
  }

  return preference;
}

/** The upstream names the seller listed for this network, in their order. */
export function preferredNamesFor(preference: X402RouterPreference, network: string) {
  const namespace = network.split(":")[0] ?? "";

  if (Object.hasOwn(preference, network)) {
    return preference[network] ?? [];
  }

  return Object.hasOwn(preference, namespace) ? (preference[namespace] ?? []) : [];
}

export function routerPreferenceHeaders(preference: X402RouterPreference) {
  return { [ROUTER_PREFERENCE_HEADER]: encodeRouterPreference(preference) };
}
