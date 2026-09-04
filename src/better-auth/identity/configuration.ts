import type { Account, BetterAuthOptions } from "better-auth";

import { isRecord } from "../../utils";
import type { TriadEnv } from "../env";
import { captureProviderProfile, sealProfileEncryptedData, type CapturedProfile } from "./profile";
import { validateEncryptionSecrets } from "./encryption";
import {
  accountSubject,
  type AuthenticationProvider,
  ethereumUpstreamId,
  type SocialProvider,
  providerSubject,
} from "./subjects";

const ACCOUNT_SUB_PATTERN = /^acc_[0-9a-f]{64}$/;
const GOOGLE_SUB_PATTERN = /^[\x21-\x7e]{1,255}$/;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/;
const IDENTITY_PROVIDERS: AuthenticationProvider[] = [
  "google",
  "github",
  "twitter",
  "ethereum",
  "passkey",
];

interface PendingIdentityUser {
  name: string;
  provider: AuthenticationProvider;
  providerSub: string;
}

function invalidUpstreamId(provider: SocialProvider): Error {
  return new Error(`Invalid ${provider} immutable upstream ID`);
}

function googleUpstreamId(profile: unknown): string {
  const upstreamId = isRecord(profile) ? profile.sub : undefined;
  if (typeof upstreamId !== "string" || !GOOGLE_SUB_PATTERN.test(upstreamId)) {
    throw invalidUpstreamId("google");
  }

  return upstreamId;
}

function githubUpstreamId(profile: unknown): string {
  const upstreamId = isRecord(profile) ? profile.id : undefined;
  if (typeof upstreamId === "number" && Number.isSafeInteger(upstreamId) && upstreamId > 0) {
    return String(upstreamId);
  }
  if (typeof upstreamId !== "string" || !DECIMAL_ID_PATTERN.test(upstreamId)) {
    throw invalidUpstreamId("github");
  }

  return upstreamId;
}

function twitterUpstreamId(profile: unknown): string {
  const data = isRecord(profile) && isRecord(profile.data) ? profile.data : undefined;
  const upstreamId = data?.id;
  if (typeof upstreamId !== "string" || !DECIMAL_ID_PATTERN.test(upstreamId)) {
    throw invalidUpstreamId("twitter");
  }

  return upstreamId;
}

async function mapIdentity(
  secret: string,
  provider: SocialProvider,
  upstreamId: string,
  profile: CapturedProfile,
  encryptionSecrets: string,
) {
  const [providerSub, accountSub] = await Promise.all([
    providerSubject(secret, provider, upstreamId),
    accountSubject(secret, provider, upstreamId),
  ]);
  const encryptedData = await sealProfileEncryptedData(encryptionSecrets, accountSub, profile);

  return {
    name: accountSub,
    email: `${accountSub}@identity.invalid`,
    emailVerified: false,
    image: "",
    provider,
    providerSub,
    ...(encryptedData ? { encryptedData } : {}),
  };
}

function sanitizedUserData(user: Record<string, unknown>): Record<string, unknown> {
  assertProviderIdentity(user);

  return {
    id: user.name,
    name: "",
    email: `${user.name}@identity.invalid`,
    emailVerified: false,
    image: "",
    provider: user.provider,
    providerSub: user.providerSub,
    encryptedData: user.encryptedData,
  };
}

async function identityUserData(
  secret: string,
  user: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if ("provider" in user || "providerSub" in user) {
    return sanitizedUserData(user);
  }

  if (typeof user.name !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(user.name)) {
    throw new Error("Triad users require a coherent provider identity");
  }

  const upstreamId = await ethereumUpstreamId(user.name);
  const [providerSub, accountSub] = await Promise.all([
    providerSubject(secret, "ethereum", upstreamId),
    accountSubject(secret, "ethereum", upstreamId),
  ]);

  return sanitizedUserData({
    ...user,
    name: accountSub,
    provider: "ethereum",
    providerSub,
  });
}

function assertProviderIdentity(
  user: Record<string, unknown>,
): asserts user is Record<string, unknown> & PendingIdentityUser {
  const provider = user.provider;
  if (
    typeof user.name !== "string" ||
    !ACCOUNT_SUB_PATTERN.test(user.name) ||
    typeof provider !== "string" ||
    !IDENTITY_PROVIDERS.includes(provider as AuthenticationProvider) ||
    typeof user.providerSub !== "string" ||
    !new RegExp(`^pid_${provider}_[0-9a-f]{64}$`).test(user.providerSub)
  ) {
    throw new Error("Triad users require a coherent provider identity");
  }
}

function stripProviderTokens(account: Partial<Account> & Record<string, unknown>) {
  return {
    ...account,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  };
}

function clearSessionRequestMetadata(session: Record<string, unknown>) {
  return {
    ...session,
    ipAddress: null,
    userAgent: null,
  };
}

function siweAuthenticationChainId(context: unknown): number | undefined {
  if (!isRecord(context) || context.path !== "/siwe/verify" || !isRecord(context.body)) {
    return undefined;
  }

  const chainId = context.body.chainId;

  return typeof chainId === "number" && Number.isSafeInteger(chainId) && chainId > 0
    ? chainId
    : undefined;
}

export function createIdentityConfiguration(env: TriadEnv) {
  validateEncryptionSecrets(env.ENCRYPTION_SECRETS, [
    env.IDENTIFIER_SECRET,
    env.RATE_LIMIT_SECRET,
    env.BETTER_AUTH_SECRET,
  ]);

  const socialProviders: NonNullable<BetterAuthOptions["socialProviders"]> = {};
  const googleClientId = env.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const githubClientId = env.GITHUB_CLIENT_ID?.trim();
  const githubClientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  const twitterClientId = env.TWITTER_CLIENT_ID?.trim();
  const twitterClientSecret = env.TWITTER_CLIENT_SECRET?.trim();

  if (googleClientId && googleClientSecret) {
    socialProviders.google = {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      disableDefaultScope: true,
      disableIdTokenSignIn: true,
      includeGrantedScopes: false,
      scope: ["openid", "email", "profile"],
      mapProfileToUser: (profile) =>
        mapIdentity(
          env.IDENTIFIER_SECRET,
          "google",
          googleUpstreamId(profile),
          captureProviderProfile("google", profile),
          env.ENCRYPTION_SECRETS,
        ),
    };
  }
  if (githubClientId && githubClientSecret) {
    socialProviders.github = {
      clientId: githubClientId,
      clientSecret: githubClientSecret,
      disableDefaultScope: true,
      disableIdTokenSignIn: true,
      scope: ["user:email"],
      mapProfileToUser: (profile) =>
        mapIdentity(
          env.IDENTIFIER_SECRET,
          "github",
          githubUpstreamId(profile),
          captureProviderProfile("github", profile),
          env.ENCRYPTION_SECRETS,
        ),
    };
  }
  if (twitterClientId && twitterClientSecret) {
    socialProviders.twitter = {
      clientId: twitterClientId,
      clientSecret: twitterClientSecret,
      disableDefaultScope: true,
      disableIdTokenSignIn: true,
      scope: ["tweet.read", "users.read"],
      mapProfileToUser: (profile) =>
        mapIdentity(
          env.IDENTIFIER_SECRET,
          "twitter",
          twitterUpstreamId(profile),
          captureProviderProfile("twitter", profile),
          env.ENCRYPTION_SECRETS,
        ),
    };
  }

  return {
    socialProviders,
    user: {
      additionalFields: {
        provider: {
          type: "string",
          required: true,
        },
        providerSub: {
          type: "string",
          required: true,
          unique: true,
        },
        encryptedData: {
          type: "string",
          required: false,
          returned: false,
        },
      },
      deleteUser: {
        enabled: true,
      },
    },
    session: {
      freshAge: 0,
      additionalFields: {
        authenticationChainId: {
          type: "number",
          required: false,
          returned: false,
        },
      },
    },
    account: {
      updateAccountOnSignIn: false,
      storeAccountCookie: false,
      accountLinking: {
        enabled: false,
        disableImplicitLinking: true,
        trustedProviders: [],
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, context) => {
            const authenticationChainId = siweAuthenticationChainId(context);

            return {
              data: {
                ...clearSessionRequestMetadata(session),
                ...(authenticationChainId ? { authenticationChainId } : {}),
              },
            };
          },
        },
        update: {
          before: async (session, _context) => ({
            data: clearSessionRequestMetadata(session),
          }),
        },
      },
      user: {
        create: {
          before: async (user, _context) => ({
            data: await identityUserData(env.IDENTIFIER_SECRET, user),
          }),
        },
        update: {
          before: async (user, _context) => {
            if (
              "provider" in user ||
              "providerSub" in user ||
              "email" in user ||
              "name" in user ||
              "image" in user ||
              "encryptedData" in user
            ) {
              return false;
            }
          },
        },
        delete: {
          before: async (user, _context) => {
            await env.DB.prepare('delete from "deviceCode" where "userId" = ?').bind(user.id).run();
          },
        },
      },
      account: {
        create: {
          before: async (account, _context) => ({ data: stripProviderTokens(account) }),
        },
        update: {
          before: async (account, _context) => ({ data: stripProviderTokens(account) }),
        },
      },
    },
  } satisfies BetterAuthOptions;
}
