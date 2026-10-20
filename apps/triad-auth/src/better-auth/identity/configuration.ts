import type { Account, BetterAuthOptions, HookEndpointContext } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { genericOAuth, type GenericOAuthUserInfo } from "better-auth/plugins";

import { isRecord } from "../../utils";
import { PROVIDER_UPSTREAM_SCOPE_MAP } from "../disclosures";
import type { TriadEnv } from "../env";
import { validateEncryptionSecrets } from "./encryption";
import {
  captureProviderProfile,
  openProfileEncryptedData,
  sealProfileEncryptedData,
  type CapturedProfile,
} from "./profile";
import {
  accountSubject,
  type AuthenticationProvider,
  ethereumUpstreamId,
  type SocialProvider,
  providerSubject,
} from "./subjects";

const ACCOUNT_SUB_PATTERN = /^acc_[0-9a-f]{64}$/;
const OIDC_SUB_PATTERN = /^[\x21-\x7e]{1,255}$/;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/;
const SIWE_CHAIN_ID_FIELD = "Chain ID: ";
const AGENTID_ISSUER = "https://auth.agentid.com";
const AGENTID_OWNER_SCOPES = ["owner_name", "owner_email"] as const;
const OWNER_MERGE_ATTEMPTS = 3;
const IDENTITY_PROVIDERS: AuthenticationProvider[] = [
  "google",
  "github",
  "twitter",
  "agentid",
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
  if (typeof upstreamId !== "string" || !OIDC_SUB_PATTERN.test(upstreamId)) {
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

function agentidUpstreamId(profile: unknown): string {
  const upstreamId = isRecord(profile) ? profile.sub : undefined;
  if (typeof upstreamId !== "string" || !OIDC_SUB_PATTERN.test(upstreamId)) {
    throw invalidUpstreamId("agentid");
  }

  return upstreamId;
}

// The access token comes from Triad's own code exchange, so the userinfo
// response is the profile. Triad does not read the ID token. A failed or
// malformed response, including one without a valid `sub`, returns null, which
// Better Auth turns into an OAuth error.
async function agentidUserInfo(accessToken: string | undefined) {
  if (!accessToken) {
    return null;
  }

  const response = await fetch(`${AGENTID_ISSUER}/v0/userinfo`, {
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
  }).catch(() => undefined);
  if (!response?.ok) {
    return null;
  }

  const profile: unknown = await response.json().catch(() => undefined);

  return isRecord(profile) && typeof profile.sub === "string" && OIDC_SUB_PATTERN.test(profile.sub)
    ? ({
        ...profile,
        emailVerified: profile.email_verified === true,
      } satisfies GenericOAuthUserInfo)
    : null;
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
    !IDENTITY_PROVIDERS.some((supported) => supported === provider) ||
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

// Better Auth takes the chain from the signed SIWE message, so the session
// records the same value. As in its parser, the last "Chain ID" line whose
// value is an integer wins. An unsafe integer is not recorded.
function siweAuthenticationChainId(context: unknown): number | undefined {
  if (
    !isRecord(context) ||
    context.path !== "/siwe/verify" ||
    !isRecord(context.body) ||
    typeof context.body.message !== "string"
  ) {
    return undefined;
  }

  let chainId: number | undefined;
  for (const line of context.body.message.split(/\r?\n/)) {
    if (!line.startsWith(SIWE_CHAIN_ID_FIELD)) {
      continue;
    }

    const parsed = Number(line.slice(SIWE_CHAIN_ID_FIELD.length));
    if (Number.isInteger(parsed)) {
      chainId = parsed;
    }
  }

  return chainId !== undefined && Number.isSafeInteger(chainId) && chainId > 0
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

// Maps the Triad owner scopes that a Client Application requested to the
// AgentID scopes that carry them.
export function agentidOwnerScopes(requested: readonly string[]): string[] {
  const upstream = PROVIDER_UPSTREAM_SCOPE_MAP.agentid;

  return [
    ...new Set(
      AGENTID_OWNER_SCOPES.filter((scope) => requested.includes(scope)).flatMap((scope) => [
        ...upstream[scope],
      ]),
    ),
  ];
}

function ownerProfile(profile: CapturedProfile): CapturedProfile {
  return {
    ...(profile.profileOwnerName === undefined
      ? {}
      : { profileOwnerName: profile.profileOwnerName }),
    ...(profile.profileOwnerEmail === undefined
      ? {}
      : { profileOwnerEmail: profile.profileOwnerEmail }),
    ...(profile.profileOwnerEmailVerified === undefined
      ? {}
      : { profileOwnerEmailVerified: profile.profileOwnerEmailVerified }),
  };
}

// True when a Client Application asks an AgentID account for owner claims that
// its encrypted profile does not hold yet. The account then signs in with
// AgentID again, and that sign-in requests the owner scopes.
export async function agentidOwnerDataMissing(
  env: TriadEnv,
  user: Record<string, unknown>,
  scopes: readonly string[],
): Promise<boolean> {
  const wantsName = scopes.includes("owner_name");
  const wantsEmail = scopes.includes("owner_email");
  if (user.provider !== "agentid" || typeof user.id !== "string" || (!wantsName && !wantsEmail)) {
    return false;
  }

  const envelope =
    typeof user.encryptedData === "string"
      ? user.encryptedData
      : (
          await env.DB.prepare('select "encryptedData" from "user" where "id" = ?')
            .bind(user.id)
            .first<{ encryptedData: unknown }>()
        )?.encryptedData;
  const profile =
    typeof envelope === "string"
      ? await openProfileEncryptedData(env.ENCRYPTION_SECRETS, user.id, envelope)
      : {};

  return (wantsName && !profile.profileOwnerName) || (wantsEmail && !profile.profileOwnerEmail);
}

// AgentID is not a built-in Better Auth provider. Generic OAuth registers it
// as a social provider, so it uses `/sign-in/social` and `/callback/agentid`.
// The endpoints are fixed because Triad builds Better Auth on every request,
// and discovery would fetch the AgentID metadata each time.
export function createAgentIdAuthentication(env: TriadEnv) {
  const clientId = env.AGENTID_CLIENT_ID?.trim();
  const clientSecret = env.AGENTID_CLIENT_SECRET?.trim();
  const signedInProfiles = new Map<string, CapturedProfile>();
  const plugin = genericOAuth({
    config:
      clientId && clientSecret
        ? [
            {
              providerId: "agentid",
              name: "AgentID",
              clientId,
              clientSecret,
              authentication: "basic",
              authorizationUrl: `${AGENTID_ISSUER}/v0/authorize`,
              tokenUrl: `${AGENTID_ISSUER}/v0/token`,
              accountIssuer: AGENTID_ISSUER,
              scopes: ["openid", "email", "profile"],
              getUserInfo: (tokens) => agentidUserInfo(tokens.accessToken),
              accountSubject: ({ profile }) => agentidUpstreamId(profile),
              mapProfileToUser: (profile) => {
                const upstreamId = agentidUpstreamId(profile);
                const captured = captureProviderProfile("agentid", profile);

                return mapIdentity(
                  env.IDENTIFIER_SECRET,
                  "agentid",
                  upstreamId,
                  captured,
                  env.ENCRYPTION_SECRETS,
                ).then((user) => {
                  signedInProfiles.set(user.name, captured);

                  return user;
                });
              },
            },
          ]
        : [],
  });

  return {
    ...plugin,
    // Generic OAuth takes the issuer only from discovery. AgentID sends `iss` on
    // its callback (RFC 9207), so Triad sets the issuer here, and Better Auth
    // rejects a callback whose `iss` is not AgentID before it redeems the code.
    init: async (...args: Parameters<typeof plugin.init>) => {
      const result = await plugin.init(...args);
      for (const provider of result.context.socialProviders) {
        if (provider.id === "agentid") {
          provider.issuer = AGENTID_ISSUER;
        }
      }

      return result;
    },
    hooks: {
      before: [
        {
          // Triad asks AgentID for the owner scopes only when the Client
          // Application's authorization request asked Triad for owner claims.
          matcher: (context: HookEndpointContext) =>
            context.path === "/sign-in/social" &&
            isRecord(context.body) &&
            context.body.provider === "agentid",
          handler: createAuthMiddleware(async (context) => {
            const query = isRecord(context.body) ? context.body.oauth_query : undefined;
            const requested =
              typeof query === "string"
                ? (new URLSearchParams(query).get("scope")?.split(" ") ?? [])
                : [];
            const scopes = agentidOwnerScopes(requested);
            if (scopes.length === 0) {
              return;
            }

            return { context: { body: { ...context.body, scopes } } };
          }),
        },
      ],
      after: [
        {
          // An existing account keeps its encrypted profile. When a later
          // sign-in brings owner data, Triad adds it to that profile.
          matcher: (context: HookEndpointContext) =>
            context.path === "/callback/:id" && context.params?.id === "agentid",
          handler: createAuthMiddleware(async (context) => {
            const userId = context.context.newSession?.user.id;
            const owner = ownerProfile((userId && signedInProfiles.get(userId)) || {});
            if (userId) {
              signedInProfiles.delete(userId);
            }
            if (!userId || Object.keys(owner).length === 0) {
              return;
            }

            // The update only applies while the stored envelope is the one this
            // sign-in read, so two concurrent sign-ins cannot drop each other's
            // owner fields. On a conflict, Triad reads the profile again.
            for (let attempt = 0; attempt < OWNER_MERGE_ATTEMPTS; attempt++) {
              const user = await context.context.adapter.findOne<{ encryptedData?: unknown }>({
                model: "user",
                where: [{ field: "id", value: userId }],
              });
              const envelope = typeof user?.encryptedData === "string" ? user.encryptedData : null;
              const stored: CapturedProfile = envelope
                ? await openProfileEncryptedData(env.ENCRYPTION_SECRETS, userId, envelope)
                : {};
              const merged: CapturedProfile = { ...stored, ...owner };
              // A new owner email never keeps the verification status of the old one.
              if (
                owner.profileOwnerEmail !== undefined &&
                owner.profileOwnerEmail !== stored.profileOwnerEmail &&
                owner.profileOwnerEmailVerified === undefined
              ) {
                delete merged.profileOwnerEmailVerified;
              }
              const encryptedData = await sealProfileEncryptedData(
                env.ENCRYPTION_SECRETS,
                userId,
                merged,
              );
              const updated = await context.context.adapter.updateMany({
                model: "user",
                where: [
                  { field: "id", value: userId },
                  ...(envelope ? [{ field: "encryptedData", value: envelope }] : []),
                ],
                update: { encryptedData },
              });
              if (updated > 0) {
                return;
              }
            }

            // The sign-in already succeeded. A later sign-in retries the merge,
            // and the owner-data check sends the agent back until it lands.
            context.context.logger.warn("AgentID owner data could not be saved");
          }),
        },
      ],
    },
  };
}
