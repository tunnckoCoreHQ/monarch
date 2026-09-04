import type {
  OAuthClaimExtensionInput,
  OAuthProviderExtension,
  OAuthUserInfoExtensionInput,
} from "@better-auth/oauth-provider";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { User } from "better-auth";
import { jwt } from "better-auth/plugins";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ACCESS_TOKEN_TTL_SECONDS,
  createTokenComposition,
  ID_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  type TokenIdentityResolver,
  type TokenProfileClaimResolver,
  type TokenSessionClaimResolver,
} from "../../src/better-auth/tokens";

const clientId = "https://client.example/metadata.json";
const resource = "https://resource.example/api";
const user = {
  createdAt: new Date("2026-07-15T00:00:00Z"),
  email: "acc_global@identity.invalid",
  emailVerified: false,
  id: "acc_global",
  name: "Triad account",
  providerSub: "pid_github_global",
  updatedAt: new Date("2026-07-15T00:00:00Z"),
} satisfies User & Record<string, unknown>;

function createIdentityResolver(): TokenIdentityResolver {
  return {
    resolvePairwiseSubject: vi.fn(
      async (accountSub, exactClientId) => `pws:${accountSub}:${exactClientId}`,
    ),
    resolveProviderSubject: vi.fn(async (identity) => String(identity.providerSub)),
  };
}

function createComposition(
  identity = createIdentityResolver(),
  profileClaims?: TokenProfileClaimResolver,
  sessionClaims?: TokenSessionClaimResolver,
) {
  return createTokenComposition({
    identity,
    profileClaims,
    sessionClaims,
    resource: {
      oauthProviderOptions: {
        enforcePerClientResources: true,
        resources: [{ identifier: resource, signingAlgorithm: "ES256" }],
        scopes: ["resource:read"],
      },
      oauthProviderExtensions: [],
    },
  });
}

function claimsExtension(
  composition: ReturnType<typeof createComposition>,
): OAuthProviderExtension {
  const extension = composition.oauthProviderOptions.extensions?.at(-1);
  if (!extension) {
    throw new Error("Token claims extension is missing");
  }

  return extension;
}

function claimInput(scopes = ["openid", "resource:read"]): OAuthClaimExtensionInput {
  return {
    client: { clientId },
    ctx: {} as OAuthClaimExtensionInput["ctx"],
    opts: {} as OAuthClaimExtensionInput["opts"],
    scopes,
    user,
  };
}

describe("token composition", () => {
  it("sets five-minute access and ID tokens with a 30-day refresh token", () => {
    const { oauthProviderOptions } = createComposition();

    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(5 * 60);
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
    expect(ID_TOKEN_TTL_SECONDS).toBe(5 * 60);
    expect(oauthProviderOptions.accessTokenExpiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(oauthProviderOptions.idTokenExpiresIn).toBe(ID_TOKEN_TTL_SECONDS);
    expect(oauthProviderOptions.refreshTokenExpiresIn).toBe(REFRESH_TOKEN_TTL_SECONDS);
  });

  it("configures ES256 signing and a public JWKS without session JWT headers", () => {
    const { jwtOptions } = createComposition();

    expect(jwtOptions).toEqual({
      disableSettingJwtHeader: true,
      jwks: { keyPairConfig: { alg: "ES256" } },
    });
  });

  it("composes through the RC.1 OAuth Provider and JWT factories", () => {
    const composition = createComposition();
    const providerPlugin = oauthProvider({
      ...composition.oauthProviderOptions,
      consentPage: "/consent",
      loginPage: "/sign-in/",
    });
    const jwtPlugin = jwt(composition.jwtOptions);

    expect(providerPlugin.options.resources).toEqual(composition.oauthProviderOptions.resources);
    expect(providerPlugin.options.resolveSubjectIdentifier).toBe(
      composition.oauthProviderOptions.resolveSubjectIdentifier,
    );
    expect(jwtPlugin.options.jwks?.keyPairConfig).toEqual({ alg: "ES256" });
  });

  it("combines canonical disclosure scopes with separate resource scopes", () => {
    const { oauthProviderOptions } = createComposition();

    expect(oauthProviderOptions.resources).toEqual([
      { identifier: resource, signingAlgorithm: "ES256" },
    ]);
    expect(oauthProviderOptions.enforcePerClientResources).toBe(true);
    expect(oauthProviderOptions.scopes).toEqual([
      "openid",
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
      "resource:read",
    ]);
    expect(oauthProviderOptions.scopes).not.toContain("profile");
  });

  it("rejects the synthetic profile scope", () => {
    expect(() =>
      createTokenComposition({
        identity: createIdentityResolver(),
        resource: {
          oauthProviderOptions: { resources: [resource], scopes: ["profile"] },
          oauthProviderExtensions: [],
        },
      }),
    ).toThrow("Token resources must not request the profile scope");
  });

  it("allows every advertised disclosure scope while defaulting registration to openid", () => {
    const { oauthProviderOptions } = createComposition();

    expect(oauthProviderOptions.clientRegistrationAllowedScopes).toEqual([
      "openid",
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
      "resource:read",
    ]);
    expect(oauthProviderOptions.clientRegistrationDefaultScopes).toEqual(["openid"]);
  });

  it("preserves resource extensions before token claim composition", () => {
    const resourceExtension: OAuthProviderExtension = {
      metadata: () => ({ resource_metadata: resource }),
    };
    const composition = createTokenComposition({
      identity: createIdentityResolver(),
      resource: {
        oauthProviderOptions: { resources: [resource], scopes: ["resource:read"] },
        oauthProviderExtensions: [resourceExtension],
      },
    });

    expect(composition.oauthProviderOptions.extensions?.[0]).toBe(resourceExtension);
    expect(composition.oauthProviderOptions.extensions).toHaveLength(2);
  });

  it("requires at least one exact resource audience", () => {
    expect(() =>
      createTokenComposition({
        identity: createIdentityResolver(),
        resource: {
          oauthProviderOptions: { scopes: ["resource:read"] },
          oauthProviderExtensions: [],
        },
      }),
    ).toThrow("Token composition requires at least one OAuth resource");
  });

  it("derives the OIDC subject from the exact client ID", async () => {
    const identity = createIdentityResolver();
    const { oauthProviderOptions } = createComposition(identity);

    const subject = await oauthProviderOptions.resolveSubjectIdentifier?.({
      clientId,
      defaultSubject: "package-default",
      subjectType: "pairwise",
      use: "id_token",
      userId: user.id,
    });

    expect(subject).toBe(`pws:${user.id}:${clientId}`);
    expect(identity.resolvePairwiseSubject).toHaveBeenCalledWith(user.id, clientId);
  });

  it("adds triple identity claims to ID tokens", async () => {
    const composition = createComposition();
    const extension = claimsExtension(composition);

    await expect(extension.claims?.idToken?.(claimInput())).resolves.toEqual({
      account_sub: user.id,
      pairwise_sub: `pws:${user.id}:${clientId}`,
      provider_sub: user.providerSub,
    });
  });

  it("adds unique sorted wallet chains and the current SIWE chain to the ID token", async () => {
    const sessionClaims: TokenSessionClaimResolver = {
      resolveAuthenticationChains: vi.fn(async () => ({
        chainId: 10,
        chains: [137, 1, 137, "invalid"],
      })),
    };
    const extension = claimsExtension(
      createComposition(createIdentityResolver(), undefined, sessionClaims),
    );
    const input = { ...claimInput(["openid", "chains"]), sessionId: "session-id" };

    await expect(extension.claims?.idToken?.(input)).resolves.toMatchObject({
      chains: [1, 10, 137],
    });
    await expect(extension.claims?.idToken?.(input)).resolves.not.toHaveProperty("chain_id");
    await expect(extension.claims?.accessToken?.(input)).resolves.not.toHaveProperty("chains");
    expect(sessionClaims.resolveAuthenticationChains).toHaveBeenCalledWith("session-id", user.id);
  });

  it("loads the granted session chain for UserInfo from the access-token session", async () => {
    const sessionClaims: TokenSessionClaimResolver = {
      resolveAuthenticationChains: vi.fn(async () => ({ chainId: 1, chains: [1] })),
    };
    const extension = claimsExtension(
      createComposition(createIdentityResolver(), undefined, sessionClaims),
    );
    const input: OAuthUserInfoExtensionInput = {
      client: { clientId },
      ctx: {} as OAuthUserInfoExtensionInput["ctx"],
      jwt: { client_id: clientId, sid: "session-id", sub: user.id },
      opts: {} as OAuthUserInfoExtensionInput["opts"],
      requestedClaims: [],
      scopes: ["openid", "chain_id"],
      user,
    };

    await expect(extension.claims?.userInfo?.(input)).resolves.toMatchObject({ chain_id: 1 });
    expect(sessionClaims.resolveAuthenticationChains).toHaveBeenCalledWith("session-id", user.id);
  });

  it("uses the first-party ID-token hook for exact requested profile scopes", async () => {
    const profileClaims: TokenProfileClaimResolver = {
      resolveProfileClaims: vi.fn(async () => ({
        email: "person@example.com",
        email_verified: true,
        preferred_username: "person",
        name: "Person Name",
        picture: "https://images.example.com/person.png",
      })),
    };
    const { oauthProviderOptions } = createComposition(createIdentityResolver(), profileClaims);

    await expect(
      oauthProviderOptions.customIdTokenClaims?.({
        metadata: {},
        scopes: ["openid", "avatar", "email"],
        user,
      }),
    ).resolves.toEqual({
      email: "person@example.com",
      email_verified: true,
      picture: "https://images.example.com/person.png",
    });
    expect(profileClaims.resolveProfileClaims).toHaveBeenCalledWith(user, ["email", "avatar"]);
  });

  it("does not resolve profile claims for identity-only ID tokens", async () => {
    const profileClaims: TokenProfileClaimResolver = {
      resolveProfileClaims: vi.fn(async () => ({ name: "Person Name" })),
    };
    const { oauthProviderOptions } = createComposition(createIdentityResolver(), profileClaims);

    await expect(
      oauthProviderOptions.customIdTokenClaims?.({ metadata: {}, scopes: ["openid"], user }),
    ).resolves.toEqual({});
    expect(profileClaims.resolveProfileClaims).not.toHaveBeenCalled();
  });

  it("rejects profile-scope token claims without a profile resolver", async () => {
    const { oauthProviderOptions } = createComposition();

    await expect(
      oauthProviderOptions.customIdTokenClaims?.({
        metadata: {},
        scopes: ["openid", "email"],
        user,
      }),
    ).rejects.toThrow("profile claim resolver");
  });

  it("rejects a resolver result missing a claim required by the requested scope", async () => {
    const profileClaims: TokenProfileClaimResolver = {
      resolveProfileClaims: vi.fn(async () => ({ email: "person@example.com" })),
    };
    const { oauthProviderOptions } = createComposition(createIdentityResolver(), profileClaims);

    await expect(
      oauthProviderOptions.customIdTokenClaims?.({
        metadata: {},
        scopes: ["openid", "email"],
        user,
      }),
    ).rejects.toThrow("email_verified");
  });

  it("keeps package-owned profile claims out of the additive ID-token extension", async () => {
    const profileClaims: TokenProfileClaimResolver = {
      resolveProfileClaims: vi.fn(async () => ({ name: "Person Name" })),
    };
    const extension = claimsExtension(createComposition(createIdentityResolver(), profileClaims));

    await expect(extension.claims?.idToken?.(claimInput(["openid", "name"]))).resolves.toEqual({
      account_sub: user.id,
      pairwise_sub: `pws:${user.id}:${clientId}`,
      provider_sub: user.providerSub,
    });
    expect(profileClaims.resolveProfileClaims).not.toHaveBeenCalled();
  });

  it("uses the first-party UserInfo hook to override package-owned standard claims", async () => {
    const profileClaims: TokenProfileClaimResolver = {
      resolveProfileClaims: vi.fn(async () => ({
        email: "person@example.com",
        email_verified: true,
        preferred_username: "person",
        picture: "https://images.example.com/person.png",
      })),
    };
    const { oauthProviderOptions } = createComposition(createIdentityResolver(), profileClaims);

    await expect(
      oauthProviderOptions.customUserInfoClaims?.({
        jwt: {},
        requestedClaims: [],
        scopes: ["openid", "email", "avatar"],
        user,
      }),
    ).resolves.toEqual({
      email: "person@example.com",
      email_verified: true,
      picture: "https://images.example.com/person.png",
    });
  });

  it("returns a public JWK for the pubkey scope", async () => {
    const pubkey = {
      crv: "Ed25519" as const,
      kty: "OKP" as const,
      x: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
    };
    const profileClaims: TokenProfileClaimResolver = {
      resolveProfileClaims: vi.fn(async () => ({ pubkey })),
    };
    const { oauthProviderOptions } = createComposition(createIdentityResolver(), profileClaims);

    await expect(
      oauthProviderOptions.customIdTokenClaims?.({
        metadata: {},
        scopes: ["openid", "pubkey"],
        user,
      }),
    ).resolves.toEqual({ pubkey });
  });

  it("returns the base64url COSE_Key for the cosekey scope", async () => {
    const cosekey = "pQECAyYgASFYIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
    const profileClaims: TokenProfileClaimResolver = {
      resolveProfileClaims: vi.fn(async () => ({ cosekey })),
    };
    const { oauthProviderOptions } = createComposition(createIdentityResolver(), profileClaims);

    await expect(
      oauthProviderOptions.customIdTokenClaims?.({
        metadata: {},
        scopes: ["openid", "cosekey"],
        user,
      }),
    ).resolves.toEqual({ cosekey });
  });

  it("adds global-subject triple claims to access tokens and introspection", async () => {
    const composition = createComposition();
    const extension = claimsExtension(composition);

    const claims = await extension.claims?.accessToken?.(claimInput());

    expect(claims).toEqual({
      account_sub: user.id,
      pairwise_sub: `pws:${user.id}:${clientId}`,
      provider_sub: user.providerSub,
    });
    expect(claims).not.toHaveProperty("sub");
    expect(claims).not.toHaveProperty("client_id");
    expect(claims).not.toHaveProperty("aud");
  });

  it("keeps optional profile claims out of bearer access tokens", async () => {
    const profileClaims: TokenProfileClaimResolver = {
      resolveProfileClaims: vi.fn(async () => ({
        email: "person@example.com",
        email_verified: true,
        preferred_username: "person",
        name: "Person Name",
        picture: "https://images.example.com/person.png",
      })),
    };
    const extension = claimsExtension(createComposition(createIdentityResolver(), profileClaims));

    await expect(
      extension.claims?.accessToken?.(claimInput(["openid", "email", "handle", "name", "avatar"])),
    ).resolves.toEqual({
      account_sub: user.id,
      pairwise_sub: `pws:${user.id}:${clientId}`,
      provider_sub: user.providerSub,
    });
    expect(profileClaims.resolveProfileClaims).not.toHaveBeenCalled();
  });

  it("adds the same pairwise subject and triple claims to UserInfo", async () => {
    const composition = createComposition();
    const extension = claimsExtension(composition);
    const input: OAuthUserInfoExtensionInput = {
      client: { clientId },
      ctx: {} as OAuthUserInfoExtensionInput["ctx"],
      jwt: { client_id: clientId, sub: user.id },
      opts: {} as OAuthUserInfoExtensionInput["opts"],
      requestedClaims: [],
      scopes: ["openid"],
      user,
    };

    await expect(extension.claims?.userInfo?.(input)).resolves.toEqual({
      account_sub: user.id,
      pairwise_sub: `pws:${user.id}:${clientId}`,
      provider_sub: user.providerSub,
    });
  });

  it("advertises truthful disclosure, resource, and claim support", () => {
    const { oauthProviderOptions } = createComposition();

    expect(oauthProviderOptions.advertisedMetadata?.subject_types_supported).toEqual(["pairwise"]);
    expect(oauthProviderOptions.advertisedMetadata?.claims_supported).toEqual([
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
    ]);
    expect(oauthProviderOptions.advertisedMetadata?.scopes_supported).toEqual([
      "openid",
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
      "resource:read",
    ]);
  });
});
