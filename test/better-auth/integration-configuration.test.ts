import { oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { jwt } from "better-auth/plugins";
import { describe, expect, it } from "vite-plus/test";

import { createTriadConfiguration } from "../../src/better-auth/configuration";
import type { TriadEnv } from "../../src/better-auth/env";

function createEnv(overrides: Partial<TriadEnv> = {}): TriadEnv {
  return {
    ASSETS: {} as Fetcher,
    DB: {} as D1Database,
    AUTH_ORIGIN: "https://auth.example.com",
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
    IDENTIFIER_SECRET: "identifier-secret-with-enough-entropy-1234567890",
    RATE_LIMIT_SECRET: "rate-limit-secret-with-enough-entropy-1234567890",
    ENCRYPTION_SECRETS:
      '{"active":"v1","secrets":{"v1":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}}',
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    TWITTER_CLIENT_ID: "twitter-client-id",
    TWITTER_CLIENT_SECRET: "twitter-client-secret",
    ...overrides,
  };
}

function requireOAuthProviderPlugin(plugins: readonly BetterAuthPlugin[]) {
  const plugin = plugins.find(
    (candidate): candidate is ReturnType<typeof oauthProvider> => candidate.id === "oauth-provider",
  );
  if (!plugin) {
    throw new Error("OAuth Provider plugin is missing");
  }

  return plugin;
}

function requireJwtPlugin(plugins: readonly BetterAuthPlugin[]) {
  const plugin = plugins.find(
    (candidate): candidate is ReturnType<typeof jwt> => candidate.id === "jwt",
  );
  if (!plugin) {
    throw new Error("JWT plugin is missing");
  }

  return plugin;
}

describe("Triad Better Auth integration configuration", () => {
  it("composes identity, OAuth Provider, JWT, CIMD, and public DCR", () => {
    const configuration = createTriadConfiguration(createEnv());
    const providerPlugin = requireOAuthProviderPlugin(configuration.plugins);
    const jwtPlugin = requireJwtPlugin(configuration.plugins);

    expect(configuration.socialProviders).toMatchObject({
      google: { clientId: "google-client-id", scope: ["openid", "email", "profile"] },
      github: { clientId: "github-client-id", scope: ["user:email"] },
      twitter: { clientId: "twitter-client-id", scope: ["tweet.read", "users.read"] },
    });
    expect(configuration.databaseHooks.user.create.before).toBeTypeOf("function");
    expect(configuration.databaseHooks.session.create.before).toBeTypeOf("function");
    expect(configuration.databaseHooks.session.update.before).toBeTypeOf("function");
    expect(configuration.databaseHooks.account.create.before).toBeTypeOf("function");
    expect(configuration.rateLimit).toMatchObject({
      enabled: true,
      customStorage: { consume: expect.any(Function) },
    });
    expect(configuration.rateLimit).toMatchObject({ storage: "database" });
    expect(configuration.plugins.map((plugin) => plugin.id)).toEqual([
      "device-authorization",
      "siwe",
      "passkey",
      "wallet-broker",
      "oauth-provider",
      "oauth-provider-device-code",
      "jwt",
    ]);

    expect(providerPlugin.options).toMatchObject({
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationRequirePKCE: true,
      grantTypes: ["authorization_code"],
      consentPage: "/consent",
      loginPage: "/me",
      accessTokenExpiresIn: 300,
      refreshTokenExpiresIn: 2_592_000,
      scopes: [
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
      ],
    });
    expect(providerPlugin.options.extensions).toHaveLength(2);
    expect(providerPlugin.options.extensions?.[0]?.claims).toBeDefined();
    expect(providerPlugin.options.extensions?.[1]?.clientDiscovery).toMatchObject({ id: "cimd" });
    expect(jwtPlugin.options).toEqual({
      disableSettingJwtHeader: true,
      jwks: { keyPairConfig: { alg: "ES256" } },
    });
  });

  it("always configures the demo resource", () => {
    const configuration = createTriadConfiguration(createEnv());
    const providerPlugin = requireOAuthProviderPlugin(configuration.plugins);

    expect(providerPlugin.options.resources).toEqual([
      {
        accessTokenTtl: 300,
        allowedScopes: [
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
        ],
        disabled: false,
        identifier: "https://auth.example.com/demo",
        name: "Triad demo",
      },
    ]);
    expect(providerPlugin.options.scopes).toEqual([
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
    ]);
  });
});
