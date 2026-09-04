import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";

import { base64UrlEncode, decodePublicJwk, type PublicJwk } from "../utils";

export interface AuthorizationServerMetadata {
  authorization_endpoint: string;
  device_authorization_endpoint: string;
  issuer: string;
  jwks_uri: string;
  registration_endpoint: string;
  token_endpoint: string;
}

export interface InspectedOAuthQuery {
  clientId: string;
  oauthQuery: string;
  resources: string[];
  scopes: DisclosureScope[];
}

export interface VerifiedIdentity {
  accountSub: string;
  expiresAt: number;
  issuer: string;
  pairwiseSub: string;
  profile: VerifiedProfile;
  providerSub: string;
}

export type ProviderName = "google" | "github" | "twitter" | "ethereum" | "passkey";
export type ProfileScope =
  | "email"
  | "handle"
  | "name"
  | "avatar"
  | "wallet"
  | "chains"
  | "chain_id"
  | "cred"
  | "pubkey"
  | "cosekey";
type DisclosureScope = "openid" | ProfileScope;

export interface ProviderCapability {
  id: ProviderName;
  scopes: readonly ProfileScope[];
}

export interface VerifiedProfile {
  avatar?: string;
  email?: string;
  emailVerified?: boolean;
  handle?: string;
  name?: string;
  wallet?: string;
  chains?: number[];
  chainId?: number;
  cred?: string;
  pubkey?: PublicJwk;
  cosekey?: string;
}

export interface DevicePollDecision {
  continuePolling: boolean;
  intervalMs: number;
  message: string;
}

interface AuthorizationRequestInput {
  authorizationEndpoint: string;
  callbackUrl: string;
  challenge: string;
  clientId: string;
  resource: string;
  scope: string;
  state: string;
}

interface TokenExchangeInput {
  callbackUrl: string;
  clientId: string;
  code: string;
  resource: string;
  verifier: string;
}

interface DeviceTokenRequestInput {
  clientId: string;
  deviceCode: string;
  resource: string;
}

const profileScopeOrder: readonly ProfileScope[] = [
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
];
const disclosureScopeOrder: readonly DisclosureScope[] = ["openid", ...profileScopeOrder];

export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export const demoProviderCapabilities: readonly ProviderCapability[] = [
  { id: "google", scopes: ["email", "name", "avatar"] },
  { id: "github", scopes: ["email", "handle", "name", "avatar"] },
  { id: "twitter", scopes: ["handle", "name", "avatar"] },
  { id: "ethereum", scopes: ["wallet", "chains", "chain_id"] },
  { id: "passkey", scopes: ["handle", "cred", "pubkey", "cosekey"] },
];

async function json(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error("The authorization server metadata could not be loaded.");
  }

  return response.json();
}

function authorizationServerMetadata(value: unknown): AuthorizationServerMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("The authorization server metadata is invalid.");
  }

  const candidate = value as Record<string, unknown>;
  for (const field of [
    "authorization_endpoint",
    "device_authorization_endpoint",
    "issuer",
    "jwks_uri",
    "registration_endpoint",
    "token_endpoint",
  ] as const) {
    if (typeof candidate[field] !== "string") {
      throw new Error("The authorization server metadata is invalid.");
    }
  }

  return candidate as unknown as AuthorizationServerMetadata;
}

function absoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function canonicalDisclosureScopes(requested: readonly string[]): DisclosureScope[] {
  const unique = new Set(requested);
  if (
    unique.size !== requested.length ||
    !unique.has("openid") ||
    [...unique].some((scope) => !disclosureScopeOrder.includes(scope as DisclosureScope))
  ) {
    throw new Error("The authorization request contains unsupported scopes.");
  }

  return disclosureScopeOrder.filter((scope) => unique.has(scope));
}

function optionalString(payload: Record<string, unknown>, claim: string): string | undefined {
  const value = payload[claim];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("The verified token has invalid profile claims.");
  }

  return value;
}

function optionalChainId(payload: Record<string, unknown>, claim: string): number | undefined {
  const value = payload[claim];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("The verified token has invalid EVM chain claims.");
  }

  return value;
}

function optionalChains(payload: Record<string, unknown>): number[] | undefined {
  const value = payload.chains;
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some(
      (chainId) => typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0,
    )
  ) {
    throw new Error("The verified token has invalid EVM chain claims.");
  }

  return value;
}

function optionalPublicJwk(payload: Record<string, unknown>): PublicJwk | undefined {
  const value = payload.pubkey;

  return value === undefined ? undefined : decodePublicJwk(value);
}

function optionalValue<Key extends keyof VerifiedProfile>(key: Key, value: VerifiedProfile[Key]) {
  return value === undefined ? {} : ({ [key]: value } as Pick<VerifiedProfile, Key>);
}

function verifiedProfile(payload: Record<string, unknown>): VerifiedProfile {
  const email = optionalString(payload, "email");
  const emailVerified = payload.email_verified;
  if (emailVerified !== undefined && (email === undefined || typeof emailVerified !== "boolean")) {
    throw new Error("The verified token has invalid profile claims.");
  }

  return {
    ...(email === undefined ? {} : { email }),
    ...(emailVerified === undefined ? {} : { emailVerified }),
    ...optionalValue("handle", optionalString(payload, "preferred_username")),
    ...optionalValue("name", optionalString(payload, "name")),
    ...optionalValue("avatar", optionalString(payload, "picture")),
    ...optionalValue("wallet", optionalString(payload, "wallet")),
    ...optionalValue("chains", optionalChains(payload)),
    ...optionalValue("chainId", optionalChainId(payload, "chain_id")),
    ...optionalValue("cred", optionalString(payload, "cred")),
    ...optionalValue("pubkey", optionalPublicJwk(payload)),
    ...optionalValue("cosekey", optionalString(payload, "cosekey")),
  };
}

export function isIdentitySigningKey(candidate: Record<string, unknown>, kid: string): boolean {
  return (
    candidate.kid === kid &&
    candidate.kty === "EC" &&
    candidate.crv === "P-256" &&
    candidate.alg === "ES256" &&
    (candidate.use === undefined || candidate.use === "sig")
  );
}

export async function createPkce(): Promise<{
  challenge: string;
  state: string;
  verifier: string;
}> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = base64UrlEncode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));

  return { challenge, state, verifier };
}

export function devicePollDecision(error: string, intervalMs: number): DevicePollDecision {
  if (error === "authorization_pending") {
    return {
      continuePolling: true,
      intervalMs,
      message: "Waiting for browser approval.",
    };
  }
  if (error === "slow_down") {
    return {
      continuePolling: true,
      intervalMs: intervalMs + 5_000,
      message: "The broker asked this device to poll less often.",
    };
  }
  if (error === "access_denied") {
    return {
      continuePolling: false,
      intervalMs,
      message: "Authorization was denied in the browser.",
    };
  }
  if (error === "expired_token") {
    return {
      continuePolling: false,
      intervalMs,
      message: "This device code expired. Start a new device flow.",
    };
  }

  return {
    continuePolling: false,
    intervalMs,
    message: "The device flow could not be completed. Start again.",
  };
}

export function authorizationRequest(input: AuthorizationRequestInput): URL {
  const url = new URL(input.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.callbackUrl,
    scope: input.scope,
    resource: input.resource,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    prompt: "login",
  }).toString();

  return url;
}

export function canonicalScopeRequest(
  provider: ProviderCapability,
  selected: readonly string[],
): string {
  const selectedScopes = new Set(selected);
  if ([...selectedScopes].some((scope) => !provider.scopes.includes(scope as ProfileScope))) {
    throw new Error("The selected provider does not support every selected scope.");
  }

  return ["openid", ...profileScopeOrder.filter((scope) => selectedScopes.has(scope))].join(" ");
}

export function demoResourceFromIssuer(issuer: string): string {
  return new URL("/demo", issuer).href;
}

export async function fetchDiscovery(
  origin = location.origin,
  signal?: AbortSignal,
): Promise<AuthorizationServerMetadata> {
  const endpoint = new URL("/api/auth/.well-known/openid-configuration", origin);

  return authorizationServerMetadata(await json(await fetch(endpoint, { signal })));
}

export function inspectOAuthQuery(search: string): InspectedOAuthQuery {
  const oauthQuery = search.startsWith("?") ? search.slice(1) : search;
  const query = new URLSearchParams(oauthQuery);
  const clientIds = query.getAll("client_id");
  const scopeValues = query.getAll("scope");
  const resources = query.getAll("resource");
  const validResources = resources.length > 0 && resources.every(absoluteHttpUrl);
  let scopes: DisclosureScope[] = [];
  if (scopeValues.length === 1) {
    scopes = canonicalDisclosureScopes(scopeValues[0]!.split(" "));
  }

  if (
    !oauthQuery ||
    clientIds.length !== 1 ||
    !clientIds[0] ||
    scopeValues.length !== 1 ||
    scopes.join(" ") !== scopeValues[0] ||
    !validResources
  ) {
    throw new Error("The authorization request is invalid or unsupported.");
  }

  return {
    clientId: clientIds[0],
    oauthQuery,
    resources,
    scopes,
  };
}

export function tokenExchangeRequest(input: TokenExchangeInput): URLSearchParams {
  return new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    redirect_uri: input.callbackUrl,
    code: input.code,
    code_verifier: input.verifier,
    resource: input.resource,
  });
}

export function oauthDeviceTokenRequest(input: DeviceTokenRequestInput): URLSearchParams {
  return new URLSearchParams({
    grant_type: DEVICE_CODE_GRANT_TYPE,
    device_code: input.deviceCode,
    client_id: input.clientId,
    resource: input.resource,
  });
}

export async function verifyIdentityToken(
  token: string,
  clientId: string,
  origin = location.origin,
  signal?: AbortSignal,
): Promise<VerifiedIdentity> {
  const discovery = await fetchDiscovery(origin, signal);
  const protectedHeader = decodeProtectedHeader(token);
  const { alg, kid } = protectedHeader;

  if (alg !== "ES256" || typeof kid !== "string") {
    throw new Error("The token has no matching ES256 signing key.");
  }

  const jwks = await json(await fetch(discovery.jwks_uri, { signal }));
  const keys =
    jwks && typeof jwks === "object" && Array.isArray((jwks as { keys?: unknown }).keys)
      ? (jwks as { keys: Record<string, unknown>[] }).keys
      : [];
  const jwk = keys.find((candidate) => isIdentitySigningKey(candidate, kid));

  if (!jwk) {
    throw new Error("The token has no matching ES256 signing key.");
  }

  const key = await importJWK(jwk as JsonWebKey, "ES256");
  const { payload } = await jwtVerify(token, key, {
    algorithms: ["ES256"],
    audience: clientId,
    issuer: discovery.issuer,
  });

  if (
    typeof payload.sub !== "string" ||
    typeof payload.pairwise_sub !== "string" ||
    payload.sub !== payload.pairwise_sub ||
    typeof payload.account_sub !== "string" ||
    typeof payload.provider_sub !== "string" ||
    typeof payload.exp !== "number"
  ) {
    throw new Error("The verified token has invalid identity claims.");
  }

  return {
    accountSub: payload.account_sub,
    expiresAt: payload.exp,
    issuer: discovery.issuer,
    pairwiseSub: payload.pairwise_sub,
    profile: verifiedProfile(payload),
    providerSub: payload.provider_sub,
  };
}
