import { describe, expect, it } from "vite-plus/test";

import {
  accountSubject,
  createIdentityConfiguration,
  openProfileEncryptedData,
  type SocialProvider,
  pairwiseSubject,
  providerSubject,
} from "../../src/better-auth/identity";
import type { TriadEnv } from "../../src/better-auth/env";

const IDENTIFIER_SECRET = "test-identifier-secret";

function createEnv(): TriadEnv {
  return {
    ASSETS: {} as Fetcher,
    DB: {} as D1Database,
    AUTH_ORIGIN: "https://auth.example.com",
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
    IDENTIFIER_SECRET,
    RATE_LIMIT_SECRET: "test-rate-limit-secret-with-enough-entropy-1234567890",
    ENCRYPTION_SECRETS:
      '{"active":"v1","secrets":{"v1":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}}',
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    TWITTER_CLIENT_ID: "twitter-client-id",
    TWITTER_CLIENT_SECRET: "twitter-client-secret",
  };
}

function createUserRecord(accountSub: string, provider: SocialProvider, providerSub: string) {
  const now = new Date("2026-01-01T00:00:00Z");

  return {
    id: "pending-user-id",
    name: accountSub,
    email: "private@example.com",
    emailVerified: true,
    image: "https://images.example.com/private.png",
    createdAt: now,
    updatedAt: now,
    provider,
    providerSub,
  };
}

function profileMapper(
  configuration: ReturnType<typeof createIdentityConfiguration>,
  provider: SocialProvider,
) {
  const configuredProvider = configuration.socialProviders[provider];
  if (!configuredProvider || typeof configuredProvider === "function") {
    throw new Error(`Expected ${provider} to be configured`);
  }
  const mapProfile = configuredProvider.mapProfileToUser as
    | ((profile: unknown) => Record<string, unknown> | Promise<Record<string, unknown>>)
    | undefined;
  if (!mapProfile) {
    throw new Error(`Expected ${provider} to map profiles`);
  }

  return mapProfile;
}

async function mappedProfile(mapped: Record<string, unknown>) {
  if (typeof mapped.name !== "string" || typeof mapped.encryptedData !== "string") {
    throw new Error("Expected encrypted profile data");
  }

  return openProfileEncryptedData(
    createEnv().ENCRYPTION_SECRETS,
    mapped.name,
    mapped.encryptedData,
  );
}

describe("Triad deterministic identity", () => {
  it("derives exact domain-separated HMAC-SHA-256 subjects", async () => {
    await expect(providerSubject(IDENTIFIER_SECRET, "github", "123456")).resolves.toBe(
      "pid_github_7a19d65bdafa7d4d7b7c76cdb0e1dfeb60e307724904e79c29ccc278ee182529",
    );
    await expect(accountSubject(IDENTIFIER_SECRET, "github", "123456")).resolves.toBe(
      "acc_8ab64ca34bb1e6ddf1431479808322a406a155eb3fa94a9301e04c4c0a1b2bcd",
    );
    await expect(
      pairwiseSubject(
        IDENTIFIER_SECRET,
        "acc_7777777777777777777777777777777777777777777777777777777777777777",
        "https://client.example/metadata.json",
      ),
    ).resolves.toBe("pws_66994e35b566efb8e33d9a0dd52f8872da80a0c929ebd709b3bf5f51ed1f84dd");
  });

  it("keeps every identity boundary domain separated", async () => {
    const providerSub = await providerSubject(IDENTIFIER_SECRET, "google", "123456");
    const accountSub = await accountSubject(IDENTIFIER_SECRET, "google", "123456");
    const otherProviderSub = await providerSubject(IDENTIFIER_SECRET, "twitter", "123456");
    const firstPairwiseSub = await pairwiseSubject(IDENTIFIER_SECRET, accountSub, "client-a");
    const secondPairwiseSub = await pairwiseSubject(IDENTIFIER_SECRET, accountSub, "client-b");

    expect(
      new Set([providerSub, accountSub, otherProviderSub, firstPairwiseSub, secondPairwiseSub]),
    ).toHaveLength(5);
  });
});

describe("Triad provider identity configuration", () => {
  it("uses fixed capability scopes and disables client-supplied ID token sign-in", () => {
    const { socialProviders } = createIdentityConfiguration(createEnv());

    expect(socialProviders.google).toMatchObject({
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
      disableDefaultScope: true,
      disableIdTokenSignIn: true,
      includeGrantedScopes: false,
      scope: ["openid", "email", "profile"],
    });
    expect(socialProviders.github).toMatchObject({
      clientId: "github-client-id",
      clientSecret: "github-client-secret",
      disableDefaultScope: true,
      disableIdTokenSignIn: true,
      scope: ["user:email"],
    });
    expect(socialProviders.twitter).toMatchObject({
      clientId: "twitter-client-id",
      clientSecret: "twitter-client-secret",
      disableDefaultScope: true,
      disableIdTokenSignIn: true,
      scope: ["tweet.read", "users.read"],
    });
  });

  it.each([
    [
      "google",
      "google-subject",
      { sub: "google-subject", name: "Google User", email: "same@example.com" },
    ],
    ["github", "123456", { id: 123456, login: "github-user", email: "same@example.com" }],
    [
      "twitter",
      "987654",
      { data: { id: "987654", name: "Twitter User", username: "twitter-user" } },
    ],
  ] as const)(
    "maps %s profiles to opaque IDs and synthetic email",
    async (provider, upstreamId, profile) => {
      const configuration = createIdentityConfiguration(createEnv());
      const mapProfile = profileMapper(configuration, provider);
      const expectedAccountSub = await accountSubject(IDENTIFIER_SECRET, provider, upstreamId);
      const expectedProviderSub = await providerSubject(IDENTIFIER_SECRET, provider, upstreamId);
      const mapped = await mapProfile(profile);
      const remapped = await mapProfile(profile);

      expect(mapped).toMatchObject({
        emailVerified: false,
        image: "",
        provider,
        providerSub: expectedProviderSub,
      });
      expect(mapped).not.toHaveProperty("id");
      expect(mapped?.name).toBe(expectedAccountSub);
      expect(mapped?.email).toBe(`${expectedAccountSub}@identity.invalid`);
      expect(mapped?.email).not.toContain("same@example.com");
      expect(remapped?.providerSub).toBe(mapped?.providerSub);
      expect(remapped?.name).toBe(mapped?.name);
      expect(remapped?.email).toBe(mapped?.email);
    },
  );

  it.each([
    [
      "google",
      {
        sub: "google-subject",
        email: "google@example.com",
        email_verified: true,
        name: "Google User",
        picture: "https://images.example.com/google.png",
      },
      {
        profileEmail: "google@example.com",
        profileEmailVerified: true,
        profileDisplayName: "Google User",
        profileAvatar: "https://images.example.com/google.png",
      },
    ],
    [
      "github",
      {
        id: 123456,
        email: "github@example.com",
        login: "github-user",
        name: "GitHub User",
        avatar_url: "https://images.example.com/github.png",
      },
      {
        profileEmail: "github@example.com",
        profileEmailVerified: false,
        profileHandle: "github-user",
        profileDisplayName: "GitHub User",
        profileAvatar: "https://images.example.com/github.png",
      },
    ],
    [
      "twitter",
      {
        data: {
          id: "987654",
          username: "twitter-user",
          name: "Twitter User",
          profile_image_url: "https://images.example.com/twitter.png",
        },
      },
      {
        profileHandle: "twitter-user",
        profileDisplayName: "Twitter User",
        profileAvatar: "https://images.example.com/twitter.png",
      },
    ],
  ] as const)(
    "captures supported %s profile fields separately",
    async (provider, profile, expected) => {
      const configuration = createIdentityConfiguration(createEnv());
      const mapped = await profileMapper(configuration, provider)(profile);

      await expect(mappedProfile(mapped)).resolves.toEqual(expected);
    },
  );

  it("omits malformed and unsupported profile values", async () => {
    const configuration = createIdentityConfiguration(createEnv());
    const mapped = await profileMapper(
      configuration,
      "google",
    )({
      sub: "google-subject",
      email: "",
      email_verified: "true",
      login: "not-a-google-capability",
      name: 42,
      picture: "javascript:alert(1)",
    });

    expect(mapped).not.toHaveProperty("encryptedData");
  });

  it("declares captured profile data as optional user fields", () => {
    const configuration = createIdentityConfiguration(createEnv());

    expect(configuration.user.additionalFields).toMatchObject({
      encryptedData: { type: "string", required: false, returned: false },
    });
  });

  it("keeps the SIWE authentication chain private on the session", () => {
    const configuration = createIdentityConfiguration(createEnv());

    expect(configuration.session.additionalFields).toEqual({
      authenticationChainId: { type: "number", required: false, returned: false },
    });
  });

  it.each([
    ["google", {}],
    ["google", { sub: "" }],
    ["google", { sub: 123456 }],
    ["github", { id: 0 }],
    ["github", { id: 1.5 }],
    ["github", { id: Number.MAX_SAFE_INTEGER + 1 }],
    ["twitter", { data: {} }],
    ["twitter", { data: { id: "01" } }],
    ["twitter", { data: { id: 123456 } }],
  ] as const)("rejects a malformed %s immutable upstream ID", (provider, profile) => {
    const configuration = createIdentityConfiguration(createEnv());
    const mapProfile = profileMapper(configuration, provider);

    expect(() => mapProfile(profile)).toThrow("immutable upstream ID");
  });

  it("disables all account linking and provider token persistence", () => {
    const configuration = createIdentityConfiguration(createEnv());

    expect(configuration.account).toEqual({
      updateAccountOnSignIn: false,
      storeAccountCookie: false,
      accountLinking: {
        enabled: false,
        disableImplicitLinking: true,
        trustedProviders: [],
      },
    });
  });

  it("preserves the account subject while sanitizing Better Auth profile fields", async () => {
    const configuration = createIdentityConfiguration(createEnv());
    const accountSub = await accountSubject(IDENTIFIER_SECRET, "github", "123456");
    const providerSub = await providerSubject(IDENTIFIER_SECRET, "github", "123456");
    const beforeCreate = configuration.databaseHooks.user.create.before;
    const encryptedProfileData = "v1.k1.iv.ciphertext";
    const user = {
      ...createUserRecord(accountSub, "github", providerSub),
      encryptedData: encryptedProfileData,
    };

    await expect(beforeCreate(user, null)).resolves.toMatchObject({
      data: {
        id: accountSub,
        name: "",
        email: `${accountSub}@identity.invalid`,
        emailVerified: false,
        image: "",
        provider: "github",
        providerSub,
        encryptedData: encryptedProfileData,
      },
    });
  });

  it("rejects incoherent provider identity during user creation", async () => {
    const configuration = createIdentityConfiguration(createEnv());
    const accountSub = await accountSubject(IDENTIFIER_SECRET, "github", "123456");
    const googleProviderSub = await providerSubject(IDENTIFIER_SECRET, "google", "123456");
    const beforeCreate = configuration.databaseHooks.user.create.before;

    await expect(
      beforeCreate(createUserRecord(accountSub, "github", googleProviderSub), null),
    ).rejects.toThrow("provider identity");
  });

  it.each([
    { name: "Changed Name" },
    { image: "https://images.example.com/changed.png" },
    { encryptedData: "v1.v1.invalid.invalid" },
  ])("rejects updates to durable identity and encrypted profile data", async (update) => {
    const configuration = createIdentityConfiguration(createEnv());

    await expect(configuration.databaseHooks.user.update.before(update, null)).resolves.toBe(false);
  });

  it.each(["create", "update"] as const)("strips tokens before account %s", async (operation) => {
    const configuration = createIdentityConfiguration(createEnv());
    const stripTokens = configuration.databaseHooks.account[operation].before;
    const account = {
      id: "account-row-id",
      issuer: "github",
      providerId: "github",
      accountId: "pid_github_subject",
      userId: "acc_subject",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      idToken: "id-secret",
      accessTokenExpiresAt: new Date("2030-01-01T00:00:00Z"),
      refreshTokenExpiresAt: new Date("2030-02-01T00:00:00Z"),
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    };

    await expect(stripTokens(account, null)).resolves.toMatchObject({
      data: {
        accessToken: null,
        refreshToken: null,
        idToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
      },
    });
  });

  it.each(["create", "update"] as const)(
    "clears request metadata before session %s",
    async (operation) => {
      const configuration = createIdentityConfiguration(createEnv());
      const clearMetadata = configuration.databaseHooks.session[operation].before;
      const session = {
        id: "session-id",
        userId: "acc_subject",
        token: "session-token",
        expiresAt: new Date("2030-01-01T00:00:00Z"),
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        ipAddress: "203.0.113.42",
        userAgent: "private user agent",
      };

      await expect(clearMetadata(session, null)).resolves.toMatchObject({
        data: {
          ipAddress: null,
          userAgent: null,
        },
      });
    },
  );

  it("records the chain used to create a SIWE session", async () => {
    const configuration = createIdentityConfiguration(createEnv());
    const session = {
      id: "session-id",
      userId: "acc_subject",
      token: "session-token",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    };

    await expect(
      configuration.databaseHooks.session.create.before(session, {
        path: "/siwe/verify",
        body: { chainId: 1 },
      } as never),
    ).resolves.toMatchObject({ data: { authenticationChainId: 1 } });
  });
});
