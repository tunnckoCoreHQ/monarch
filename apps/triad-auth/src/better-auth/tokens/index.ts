import type {
  OAuthClaimExtensionInput,
  OAuthOptions,
  OAuthProviderExtension,
  OAuthUserInfoExtensionInput,
  Scope,
} from "@better-auth/oauth-provider";
import type { JwtOptions } from "better-auth/plugins";

import { decodePublicJwk, type PublicJwk } from "../../utils";
import {
  DISCLOSURE_CLAIMS,
  DISCLOSURE_SCOPES,
  OPTIONAL_DISCLOSURE_SCOPES,
  type OptionalDisclosureScope,
} from "../disclosures";

export const ACCESS_TOKEN_TTL_SECONDS = 5 * 60;
export const ID_TOKEN_TTL_SECONDS = 5 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface TokenIdentityUser {
  id: string;
  [key: string]: unknown;
}

export interface TokenIdentityResolver {
  resolvePairwiseSubject(accountSub: string, clientId: string): string | Promise<string>;
  resolveProviderSubject(user: TokenIdentityUser): string | Promise<string>;
}

export interface TokenProfileClaims {
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  name?: string;
  picture?: string;
  wallet?: string;
  cred?: string;
  pubkey?: PublicJwk;
  cosekey?: string;
}

export interface TokenSessionClaimResolver {
  resolveAuthenticationChains(
    sessionId: string,
    userId: string,
  ): { chainId?: number; chains: unknown[] } | Promise<{ chainId?: number; chains: unknown[] }>;
}

export interface TokenProfileClaimResolver {
  resolveProfileClaims(
    user: TokenIdentityUser,
    scopes: readonly OptionalDisclosureScope[],
  ): TokenProfileClaims | Promise<TokenProfileClaims>;
}

type OAuthResourceOptionName =
  | "accessTokenExpiresIn"
  | "cachedResources"
  | "enforcePerClientResources"
  | "identifierValidator"
  | "refreshTokenExpiresIn"
  | "resourcePrivileges"
  | "resources"
  | "resourceSeedMode"
  | "scopes";

export type TokenResourceOptions = Pick<OAuthOptions<Scope[]>, OAuthResourceOptionName>;

export interface TokenResourceFragment {
  oauthProviderOptions: TokenResourceOptions;
  oauthProviderExtensions: readonly OAuthProviderExtension[];
}

export interface TokenCompositionDependencies {
  identity: TokenIdentityResolver;
  profileClaims?: TokenProfileClaimResolver;
  sessionClaims?: TokenSessionClaimResolver;
  resource: TokenResourceFragment;
}

interface TripleIdentityClaims extends Record<string, unknown> {
  account_sub: string;
  pairwise_sub: string;
  provider_sub: string;
}

async function resolveTripleIdentityClaims(
  identity: TokenIdentityResolver,
  user: TokenIdentityUser,
  clientId: string,
): Promise<TripleIdentityClaims> {
  const accountSub = user.id;
  const [pairwiseSub, providerSub] = await Promise.all([
    identity.resolvePairwiseSubject(accountSub, clientId),
    identity.resolveProviderSubject(user),
  ]);

  return {
    account_sub: accountSub,
    pairwise_sub: pairwiseSub,
    provider_sub: providerSub,
  };
}

function assignProfileClaim(
  claims: TokenProfileClaims,
  claim: keyof TokenProfileClaims,
  value: unknown,
): void {
  if (value === undefined) {
    throw new Error(`Token profile resolver did not return the required ${claim} claim`);
  }
  if (claim === "pubkey") {
    claims.pubkey = decodePublicJwk(value);

    return;
  }
  if (claim === "email_verified") {
    if (typeof value !== "boolean") {
      throw new Error(`Token profile resolver returned an invalid ${claim} claim`);
    }
    claims.email_verified = value;

    return;
  }
  if (typeof value !== "string") {
    throw new Error(`Token profile resolver returned an invalid ${claim} claim`);
  }

  Object.assign(claims, { [claim]: value });
}

function validChainId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function resolveSessionClaims(
  resolver: TokenSessionClaimResolver | undefined,
  scopes: readonly string[],
  sessionId: string | undefined,
  userId: string | undefined,
): Promise<Record<string, unknown>> {
  const includeChains = scopes.includes("chains");
  const includeChainId = scopes.includes("chain_id");
  if (!includeChains && !includeChainId) {
    return {};
  }
  if (!resolver || !sessionId || !userId) {
    throw new Error("Ethereum chain scopes require an authentication session");
  }

  const resolved = await resolver.resolveAuthenticationChains(sessionId, userId);
  const chainId = resolved.chainId;
  if (!validChainId(chainId)) {
    throw new Error("The authentication session does not contain a valid chain_id claim");
  }

  const chains = [...new Set([...resolved.chains.filter(validChainId), chainId])].sort(
    (left, right) => left - right,
  );

  return {
    ...(includeChains ? { chains } : {}),
    ...(includeChainId ? { chain_id: chainId } : {}),
  };
}

async function resolveScopedProfileClaims(
  resolver: TokenProfileClaimResolver | undefined,
  user: TokenIdentityUser,
  scopes: readonly string[],
): Promise<TokenProfileClaims> {
  const requestedScopes = OPTIONAL_DISCLOSURE_SCOPES.filter(
    (scope) => scope !== "chains" && scope !== "chain_id" && scopes.includes(scope),
  );
  if (requestedScopes.length === 0) {
    return {};
  }
  if (!resolver) {
    throw new Error("Token profile scopes require a profile claim resolver");
  }

  const resolved = await resolver.resolveProfileClaims(user, requestedScopes);
  const claims: TokenProfileClaims = {};

  for (const scope of requestedScopes) {
    for (const claim of DISCLOSURE_CLAIMS[scope]) {
      if (claim === "chains" || claim === "chain_id") {
        continue;
      }
      assignProfileClaim(claims, claim, resolved[claim]);
    }
  }

  return claims;
}

function userInfoClientId(input: OAuthUserInfoExtensionInput): string {
  const tokenClientId =
    typeof input.jwt.client_id === "string"
      ? input.jwt.client_id
      : typeof input.jwt.azp === "string"
        ? input.jwt.azp
        : undefined;
  const clientId = input.client?.clientId ?? tokenClientId;
  if (!clientId) {
    throw new Error("UserInfo identity claims require an exact client ID");
  }

  return clientId;
}

function createIdentityClaimsExtension(
  identity: TokenIdentityResolver,
  sessionClaims: TokenSessionClaimResolver | undefined,
): OAuthProviderExtension {
  return {
    claims: {
      accessToken: async (input: OAuthClaimExtensionInput) => ({
        ...(input.user
          ? await resolveTripleIdentityClaims(identity, input.user, input.client.clientId)
          : {}),
      }),
      idToken: async (input: OAuthClaimExtensionInput) => ({
        ...(input.user
          ? await resolveTripleIdentityClaims(identity, input.user, input.client.clientId)
          : {}),
        ...(await resolveSessionClaims(
          sessionClaims,
          input.scopes,
          input.sessionId,
          input.user?.id,
        )),
      }),
      userInfo: async (input: OAuthUserInfoExtensionInput) => ({
        ...(await resolveTripleIdentityClaims(identity, input.user, userInfoClientId(input))),
        ...(await resolveSessionClaims(
          sessionClaims,
          input.scopes,
          typeof input.jwt.sid === "string" ? input.jwt.sid : undefined,
          input.user.id,
        )),
      }),
    },
  };
}

function tokenScopes(resourceScopes: readonly Scope[]): Scope[] {
  for (const scope of resourceScopes) {
    if (scope === "profile") {
      throw new Error(`Token resources must not request the ${scope} scope`);
    }
  }

  return [...new Set<Scope>([...DISCLOSURE_SCOPES, ...resourceScopes])];
}

export function createTokenComposition({
  identity,
  profileClaims,
  sessionClaims,
  resource,
}: TokenCompositionDependencies) {
  const resolveSubjectIdentifier: NonNullable<OAuthOptions["resolveSubjectIdentifier"]> = (input) =>
    identity.resolvePairwiseSubject(input.userId, input.clientId);
  const claimsExtension = createIdentityClaimsExtension(identity, sessionClaims);
  const {
    resources,
    scopes: resourceScopes = [],
    ...resourceOptions
  } = resource.oauthProviderOptions;
  if (!resources?.length) {
    throw new Error("Token composition requires at least one OAuth resource");
  }
  const scopes = tokenScopes(resourceScopes);
  const advertisedMetadata = {
    subject_types_supported: ["pairwise"] as const,
    scopes_supported: scopes,
    claims_supported: [
      "sub",
      "pairwise_sub",
      "account_sub",
      "provider_sub",
      "email",
      "email_verified",
      "preferred_username",
      "name",
      "picture",
      "wallet",
      "chains",
      "chain_id",
      "cred",
      "pubkey",
      "cosekey",
    ],
  } as NonNullable<OAuthOptions<Scope[]>["advertisedMetadata"]> & {
    subject_types_supported: readonly ["pairwise"];
  };

  const oauthProviderOptions = {
    ...resourceOptions,
    accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
    idTokenExpiresIn: ID_TOKEN_TTL_SECONDS,
    refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
    resources,
    scopes,
    clientRegistrationAllowedScopes: scopes,
    clientRegistrationDefaultScopes: ["openid"],
    resolveSubjectIdentifier,
    customIdTokenClaims: (input) =>
      resolveScopedProfileClaims(profileClaims, input.user, input.scopes),
    customUserInfoClaims: (input) =>
      resolveScopedProfileClaims(profileClaims, input.user, input.scopes),
    extensions: [...resource.oauthProviderExtensions, claimsExtension],
    advertisedMetadata,
  } satisfies Partial<OAuthOptions<Scope[]>>;
  const jwtOptions = {
    disableSettingJwtHeader: true,
    jwks: { keyPairConfig: { alg: "ES256" } },
  } satisfies JwtOptions;

  return { oauthProviderOptions, jwtOptions };
}

export type TokenComposition = ReturnType<typeof createTokenComposition>;
