export const OPTIONAL_DISCLOSURE_SCOPES = [
  "email",
  "handle",
  "name",
  "avatar",
  "wallet",
  "chains",
  "chain_id",
  "cred",
  "pubkey",
  "cosekey",
] as const;
export const DISCLOSURE_SCOPES = ["openid", ...OPTIONAL_DISCLOSURE_SCOPES] as const;

export type DisclosureScope = (typeof DISCLOSURE_SCOPES)[number];
export type OptionalDisclosureScope = (typeof OPTIONAL_DISCLOSURE_SCOPES)[number];
export type DisclosureProvider = "google" | "github" | "twitter" | "ethereum" | "passkey";

export const DISCLOSURE_CLAIMS = {
  openid: ["pairwise_sub", "account_sub", "provider_sub"],
  email: ["email", "email_verified"],
  handle: ["preferred_username"],
  name: ["name"],
  avatar: ["picture"],
  wallet: ["wallet"],
  chains: ["chains"],
  chain_id: ["chain_id"],
  cred: ["cred"],
  pubkey: ["pubkey"],
  cosekey: ["cosekey"],
} as const satisfies Record<DisclosureScope, readonly string[]>;

export type DisclosureClaim = (typeof DISCLOSURE_CLAIMS)[DisclosureScope][number];

export const PROVIDER_DISCLOSURE_SCOPES = {
  google: ["email", "name", "avatar"],
  github: ["email", "handle", "name", "avatar"],
  twitter: ["handle", "name", "avatar"],
  ethereum: ["wallet", "chains", "chain_id"],
  passkey: ["handle", "cred", "pubkey", "cosekey"],
} as const satisfies Record<DisclosureProvider, readonly OptionalDisclosureScope[]>;

export const PROVIDER_UPSTREAM_SCOPE_MAP = {
  google: {
    openid: ["openid"],
    email: ["email"],
    handle: [],
    name: ["profile"],
    avatar: ["profile"],
    wallet: [],
    chains: [],
    chain_id: [],
    cred: [],
    pubkey: [],
    cosekey: [],
  },
  github: {
    openid: [],
    email: ["user:email"],
    handle: [],
    name: [],
    avatar: [],
    wallet: [],
    chains: [],
    chain_id: [],
    cred: [],
    pubkey: [],
    cosekey: [],
  },
  twitter: {
    openid: ["tweet.read", "users.read"],
    email: [],
    handle: [],
    name: [],
    avatar: [],
    wallet: [],
    chains: [],
    chain_id: [],
    cred: [],
    pubkey: [],
    cosekey: [],
  },
  ethereum: {
    openid: [],
    email: [],
    handle: [],
    name: [],
    avatar: [],
    wallet: [],
    chains: [],
    chain_id: [],
    cred: [],
    pubkey: [],
    cosekey: [],
  },
  passkey: {
    openid: [],
    email: [],
    handle: [],
    name: [],
    avatar: [],
    wallet: [],
    chains: [],
    chain_id: [],
    cred: [],
    pubkey: [],
    cosekey: [],
  },
} as const satisfies Record<DisclosureProvider, Record<DisclosureScope, readonly string[]>>;

export function canonicalDisclosureScopes(requested: readonly string[] = []): DisclosureScope[] {
  if (requested.length === 0) {
    return ["openid"];
  }

  const uniqueRequested = new Set(requested);
  if (uniqueRequested.size !== requested.length) {
    throw new Error("duplicate disclosure scopes are not allowed");
  }
  for (const scope of requested) {
    if (!DISCLOSURE_SCOPES.includes(scope as DisclosureScope)) {
      throw new Error(`unsupported disclosure scope: ${scope}`);
    }
  }
  if (!uniqueRequested.has("openid")) {
    throw new Error("the openid scope is mandatory");
  }

  return DISCLOSURE_SCOPES.filter((scope) => uniqueRequested.has(scope));
}

export function claimsForDisclosureScopes(scopes: readonly DisclosureScope[]): DisclosureClaim[] {
  return scopes.flatMap((scope) => [...DISCLOSURE_CLAIMS[scope]]);
}

export function validateProviderDisclosureScopes(
  provider: DisclosureProvider,
  scopes: readonly DisclosureScope[],
): void {
  const supported = new Set<DisclosureScope>(["openid", ...PROVIDER_DISCLOSURE_SCOPES[provider]]);

  for (const scope of scopes) {
    if (!supported.has(scope)) {
      throw new Error(`${provider} does not support the ${scope} disclosure scope`);
    }
  }
}

export function upstreamScopesForProvider(
  provider: DisclosureProvider,
  scopes: readonly DisclosureScope[],
): string[] {
  validateProviderDisclosureScopes(provider, scopes);
  const canonicalScopes = DISCLOSURE_SCOPES.filter((scope) => scopes.includes(scope));

  return [
    ...new Set(canonicalScopes.flatMap((scope) => PROVIDER_UPSTREAM_SCOPE_MAP[provider][scope])),
  ];
}
