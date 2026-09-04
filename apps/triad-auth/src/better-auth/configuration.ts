import { deviceCodeGrant, oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";

import { createClientAdmissionFragment } from "./admission";
import type { TriadAuthConfiguration } from "./auth";
import { createTriadDeviceAuthorization } from "./device";
import {
  type DisclosureProvider,
  type DisclosureScope,
  validateProviderDisclosureScopes,
} from "./disclosures";
import type { TriadEnv } from "./env";
import {
  createIdentityConfiguration,
  createEthereumAuthentication,
  createPasskeyAuthentication,
  createProfileClaimResolver,
  createSessionClaimResolver,
  isSocialProvider,
  pairwiseSubject,
} from "./identity";
import { createD1RateLimitStorage, RATE_LIMIT_WINDOW_SECONDS } from "./rate-limit";
import { createTriadResourceFragment } from "./resources";
import { createTokenComposition, type TokenIdentityUser } from "./tokens";
import { walletBrokerPlugin } from "./wallet";

function providerSubjectFromUser(user: TokenIdentityUser): string {
  if (typeof user.providerSub !== "string") {
    throw new Error("Token identity requires a provider subject");
  }

  return user.providerSub;
}

function preservePluginTuple<const Plugins extends BetterAuthPlugin[]>(plugins: Plugins): Plugins {
  return plugins;
}

function validateProviderAuthorization(
  user: Record<string, unknown>,
  scopes: readonly string[],
): void {
  const provider = user.provider;
  if (!isSocialProvider(provider) && provider !== "ethereum" && provider !== "passkey") {
    throw new APIError("BAD_REQUEST", { message: "Identity provider is invalid" });
  }

  try {
    validateProviderDisclosureScopes(
      provider satisfies DisclosureProvider,
      scopes as readonly DisclosureScope[],
    );
  } catch (reason) {
    throw new APIError("BAD_REQUEST", {
      message: reason instanceof Error ? reason.message : "Provider does not support these scopes",
    });
  }
}

export function createTriadConfiguration(env: TriadEnv) {
  const identityConfiguration = createIdentityConfiguration(env);
  const resourceFragment = createTriadResourceFragment(env);
  const admissionFragment = createClientAdmissionFragment();
  const tokenComposition = createTokenComposition({
    identity: {
      resolvePairwiseSubject: (accountSub, clientId) =>
        pairwiseSubject(env.IDENTIFIER_SECRET, accountSub, clientId),
      resolveProviderSubject: providerSubjectFromUser,
    },
    profileClaims: createProfileClaimResolver({
      encryptionSecrets: env.ENCRYPTION_SECRETS,
      database: env.DB,
      identifierSecret: env.IDENTIFIER_SECRET,
    }),
    sessionClaims: createSessionClaimResolver(env.DB),
    resource: resourceFragment,
  });
  const { extensions: admissionExtensions, ...admissionOptions } = admissionFragment.oauthProvider;
  const { extensions: tokenExtensions, ...tokenOptions } = tokenComposition.oauthProviderOptions;
  const plugins = preservePluginTuple([
    ...resourceFragment.betterAuthPlugins,
    createTriadDeviceAuthorization(env),
    createEthereumAuthentication(env),
    createPasskeyAuthentication(env),
    walletBrokerPlugin,
    oauthProvider({
      ...tokenOptions,
      ...admissionOptions,
      consentPage: "/consent",
      loginPage: "/me",
      postLogin: {
        page: "/me",
        shouldRedirect: ({ user, scopes }) => {
          validateProviderAuthorization(user, scopes);

          return false;
        },
        consentReferenceId: ({ user, scopes }) => {
          validateProviderAuthorization(user, scopes);

          return undefined;
        },
      },
      pairwiseSecret: env.IDENTIFIER_SECRET,
      rateLimit: {
        token: { window: RATE_LIMIT_WINDOW_SECONDS, max: 20 },
        authorize: { window: RATE_LIMIT_WINDOW_SECONDS, max: 30 },
        introspect: { window: RATE_LIMIT_WINDOW_SECONDS, max: 60 },
        revoke: { window: RATE_LIMIT_WINDOW_SECONDS, max: 30 },
        register: { window: RATE_LIMIT_WINDOW_SECONDS, max: 5 },
        userinfo: { window: RATE_LIMIT_WINDOW_SECONDS, max: 60 },
      },
      extensions: [...tokenExtensions, ...admissionExtensions],
    }),
    deviceCodeGrant(),
    jwt(tokenComposition.jwtOptions),
  ]);

  return {
    ...identityConfiguration,
    rateLimit: {
      enabled: true,
      storage: "database",
      customStorage: createD1RateLimitStorage(env.DB, env.RATE_LIMIT_SECRET),
      window: RATE_LIMIT_WINDOW_SECONDS,
      max: 60,
      customRules: {
        "/sign-in/social": { window: RATE_LIMIT_WINDOW_SECONDS, max: 10 },
        "/siwe/nonce": { window: RATE_LIMIT_WINDOW_SECONDS, max: 10 },
        "/siwe/verify": { window: RATE_LIMIT_WINDOW_SECONDS, max: 10 },
        "/passkey/generate-register-options": { window: RATE_LIMIT_WINDOW_SECONDS, max: 10 },
        "/passkey/verify-registration": { window: RATE_LIMIT_WINDOW_SECONDS, max: 10 },
        "/passkey/generate-authenticate-options": {
          window: RATE_LIMIT_WINDOW_SECONDS,
          max: 20,
        },
        "/passkey/verify-authentication": { window: RATE_LIMIT_WINDOW_SECONDS, max: 20 },
        "/device/code": { window: RATE_LIMIT_WINDOW_SECONDS, max: 10 },
        "/device": { window: RATE_LIMIT_WINDOW_SECONDS, max: 30 },
        "/device/token": { window: RATE_LIMIT_WINDOW_SECONDS, max: 30 },
      },
    },
    plugins,
  } satisfies TriadAuthConfiguration;
}
