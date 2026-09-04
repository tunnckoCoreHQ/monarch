import type { SocialProvider } from "./subjects";
import type { OptionalDisclosureScope } from "../disclosures";
import { base64UrlDecode, base64UrlEncode, isRecord, type PublicJwk } from "../../utils";
import { openEncryptedData, sealEncryptedData, validateEncryptionSecrets } from "./encryption";
import {
  isIdentityPasskey,
  storedPasskeyCoseKey,
  storedPasskeyPublicJwk,
} from "./passkey-public-key";

const SYNTHETIC_EMAIL_SUFFIX = "@identity.invalid";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_CREDENTIAL_ID_BYTES = 1023;

export interface CapturedProfile {
  profileEmail?: string;
  profileEmailVerified?: boolean;
  profileHandle?: string;
  profileDisplayName?: string;
  profileAvatar?: string;
}

interface StoredProfileData {
  email?: string;
  email_verified?: boolean;
  handle?: string;
  name?: string;
  avatar_url?: string;
}

export interface ProfileIdentityUser {
  id: string;
  [key: string]: unknown;
}

export interface ProfileClaims {
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

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();

  return normalized || undefined;
}

function emailAddress(value: unknown): string | undefined {
  const email = nonEmptyString(value);

  return email && EMAIL_PATTERN.test(email) ? email : undefined;
}

function webUrl(value: unknown): string | undefined {
  const url = nonEmptyString(value);
  if (!url) {
    return undefined;
  }

  try {
    const parsed = new URL(url);

    return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function credentialId(value: unknown): string | undefined {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    return undefined;
  }

  try {
    const decoded = base64UrlDecode(value);
    if (decoded.byteLength === 0 || decoded.byteLength > MAX_CREDENTIAL_ID_BYTES) {
      return undefined;
    }

    return base64UrlEncode(decoded) === value ? value : undefined;
  } catch {
    return undefined;
  }
}

function storedProfileFromCaptured(profile: CapturedProfile): StoredProfileData {
  const data: StoredProfileData = {};
  if (profile.profileEmail !== undefined) {
    data.email = profile.profileEmail;
  }
  if (profile.profileEmailVerified !== undefined) {
    data.email_verified = profile.profileEmailVerified;
  }
  if (profile.profileHandle !== undefined) {
    data.handle = profile.profileHandle;
  }
  if (profile.profileDisplayName !== undefined) {
    data.name = profile.profileDisplayName;
  }
  if (profile.profileAvatar !== undefined) {
    data.avatar_url = profile.profileAvatar;
  }

  return data;
}

function capturedFromProfileData(value: unknown): CapturedProfile {
  if (!isRecord(value)) {
    throw new Error("Invalid profile data payload");
  }

  const allowedFields = new Set(["email", "email_verified", "handle", "name", "avatar_url"]);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    throw new Error("Invalid profile data payload");
  }

  const profile: CapturedProfile = {};
  if (value.email !== undefined) {
    if (typeof value.email !== "string") {
      throw new Error("Invalid profile email payload");
    }
    profile.profileEmail = value.email;
  }
  if (value.email_verified !== undefined) {
    if (typeof value.email_verified !== "boolean") {
      throw new Error("Invalid profile email verification payload");
    }
    profile.profileEmailVerified = value.email_verified;
  }
  if (value.handle !== undefined) {
    if (typeof value.handle !== "string") {
      throw new Error("Invalid profile handle payload");
    }
    profile.profileHandle = value.handle;
  }
  if (value.name !== undefined) {
    if (typeof value.name !== "string") {
      throw new Error("Invalid profile name payload");
    }
    profile.profileDisplayName = value.name;
  }
  if (value.avatar_url !== undefined) {
    if (typeof value.avatar_url !== "string") {
      throw new Error("Invalid profile avatar payload");
    }
    profile.profileAvatar = value.avatar_url;
  }

  return profile;
}

export async function sealProfileEncryptedData(
  encryptionSecrets: string,
  accountSub: string,
  profile: CapturedProfile,
): Promise<string | undefined> {
  const data = storedProfileFromCaptured(profile);
  if (Object.keys(data).length === 0) {
    return undefined;
  }

  return sealEncryptedData(encryptionSecrets, "user", accountSub, data);
}

export async function openProfileEncryptedData(
  encryptionSecrets: string,
  accountSub: string,
  envelope: string,
): Promise<CapturedProfile> {
  return capturedFromProfileData(
    await openEncryptedData(encryptionSecrets, "user", accountSub, envelope),
  );
}

function googleProfile(profile: unknown): CapturedProfile {
  if (!isRecord(profile)) {
    return {};
  }

  const captured: CapturedProfile = {};
  const email = emailAddress(profile.email);
  if (email) {
    captured.profileEmail = email;
    if (typeof profile.email_verified === "boolean") {
      captured.profileEmailVerified = profile.email_verified;
    }
  }

  const displayName = nonEmptyString(profile.name);
  if (displayName) {
    captured.profileDisplayName = displayName;
  }

  const avatar = webUrl(profile.picture);
  if (avatar) {
    captured.profileAvatar = avatar;
  }

  return captured;
}

function githubProfile(profile: unknown): CapturedProfile {
  if (!isRecord(profile)) {
    return {};
  }

  const captured: CapturedProfile = {};
  const email = emailAddress(profile.email);
  if (email) {
    captured.profileEmail = email;
    captured.profileEmailVerified = false;
  }

  const handle = nonEmptyString(profile.login);
  if (handle) {
    captured.profileHandle = handle;
  }

  const displayName = nonEmptyString(profile.name);
  if (displayName) {
    captured.profileDisplayName = displayName;
  }

  const avatar = webUrl(profile.avatar_url);
  if (avatar) {
    captured.profileAvatar = avatar;
  }

  return captured;
}

function twitterProfile(profile: unknown): CapturedProfile {
  const data = isRecord(profile) && isRecord(profile.data) ? profile.data : undefined;
  if (!data) {
    return {};
  }

  const captured: CapturedProfile = {};
  const handle = nonEmptyString(data.username);
  if (handle) {
    captured.profileHandle = handle;
  }

  const displayName = nonEmptyString(data.name);
  if (displayName) {
    captured.profileDisplayName = displayName;
  }

  const avatar = webUrl(data.profile_image_url);
  if (avatar) {
    captured.profileAvatar = avatar;
  }

  return captured;
}

export function captureProviderProfile(
  provider: SocialProvider,
  profile: unknown,
): CapturedProfile {
  if (provider === "google") {
    return googleProfile(profile);
  }
  if (provider === "github") {
    return githubProfile(profile);
  }

  return twitterProfile(profile);
}

async function resolveProfileClaims(
  user: CapturedProfile,
  scopes: readonly OptionalDisclosureScope[],
): Promise<ProfileClaims> {
  const claims: ProfileClaims = {};

  if (scopes.includes("email")) {
    const email = emailAddress(user.profileEmail);
    if (email && !email.toLowerCase().endsWith(SYNTHETIC_EMAIL_SUFFIX)) {
      claims.email = email;
      if (typeof user.profileEmailVerified === "boolean") {
        claims.email_verified = user.profileEmailVerified;
      }
    }
  }

  if (scopes.includes("handle")) {
    const handle = nonEmptyString(user.profileHandle);
    if (handle) {
      claims.preferred_username = handle;
    }
  }

  if (scopes.includes("name")) {
    const displayName = nonEmptyString(user.profileDisplayName);
    if (displayName) {
      claims.name = displayName;
    }
  }

  if (scopes.includes("avatar")) {
    const avatar = webUrl(user.profileAvatar);
    if (avatar) {
      claims.picture = avatar;
    }
  }

  return claims;
}

async function walletClaim(database: D1Database, userId: string): Promise<string | undefined> {
  const row = await database
    .prepare(
      'select "address" from "walletAddress" where "userId" = ? order by "createdAt" asc limit 1',
    )
    .bind(userId)
    .first<{ address: unknown }>();
  const address = row?.address;

  return typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address) ? address : undefined;
}

async function passkeyClaims(
  database: D1Database,
  user: ProfileIdentityUser,
  identifierSecret: string,
): Promise<Pick<ProfileClaims, "cred" | "pubkey" | "cosekey">> {
  if (user.provider !== "passkey" || typeof user.providerSub !== "string") {
    return {};
  }
  const providerSub = user.providerSub;
  const result = await database
    .prepare('select "credentialID", "publicKey" from "passkey" where "userId" = ?')
    .bind(user.id)
    .all<{ credentialID: unknown; publicKey: unknown }>();
  const candidates = await Promise.all(
    result.results.map(async (candidate) => ({
      candidate,
      identity:
        typeof candidate.publicKey === "string" &&
        (await isIdentityPasskey(identifierSecret, providerSub, candidate.publicKey)),
    })),
  );
  const row = candidates.find(({ identity }) => identity)?.candidate;
  if (typeof row?.credentialID !== "string" || typeof row.publicKey !== "string") {
    return {};
  }
  const cred = credentialId(row.credentialID);
  const pubkey = storedPasskeyPublicJwk(row.publicKey);
  const cosekey = storedPasskeyCoseKey(row.publicKey);

  return {
    ...(cred ? { cred } : {}),
    pubkey,
    cosekey,
  };
}

interface ProfileClaimResolverOptions {
  encryptionSecrets: string;
  database?: D1Database;
  identifierSecret?: string;
}

export function createProfileClaimResolver(options: ProfileClaimResolverOptions) {
  const { database, encryptionSecrets, identifierSecret } = options;
  validateEncryptionSecrets(encryptionSecrets);

  return {
    resolveProfileClaims: async (
      user: ProfileIdentityUser,
      scopes: readonly OptionalDisclosureScope[],
    ) => {
      if (scopes.length === 0) {
        return {};
      }

      const passkeyScopes: readonly OptionalDisclosureScope[] = ["cred", "pubkey", "cosekey"];
      const databaseScopes: readonly OptionalDisclosureScope[] = ["wallet", ...passkeyScopes];
      const requiresDatabaseClaims = scopes.some((scope) => databaseScopes.includes(scope));
      if (requiresDatabaseClaims && !database) {
        throw new Error("Credential claims require an identity database");
      }
      const requiresPasskeyClaims = scopes.some((scope) => passkeyScopes.includes(scope));
      if (requiresPasskeyClaims && !identifierSecret) {
        throw new Error("Identity Passkey claims require the identifier secret");
      }
      const walletPromise: Promise<string | undefined> =
        scopes.includes("wallet") && database
          ? walletClaim(database, user.id)
          : Promise.resolve(undefined);
      let passkeyPromise: Promise<Pick<ProfileClaims, "cred" | "pubkey" | "cosekey">> =
        Promise.resolve({});
      if (requiresPasskeyClaims && database && identifierSecret) {
        passkeyPromise = passkeyClaims(database, user, identifierSecret);
      }

      const [profile, wallet, passkey] = await Promise.all([
        typeof user.encryptedData === "string"
          ? openProfileEncryptedData(encryptionSecrets, user.id, user.encryptedData)
          : {},
        walletPromise,
        passkeyPromise,
      ]);
      const claims = await resolveProfileClaims(profile, scopes);
      if (wallet) {
        claims.wallet = wallet;
      }
      if (scopes.includes("cred") && passkey.cred) {
        claims.cred = passkey.cred;
      }
      if (scopes.includes("pubkey") && passkey.pubkey) {
        claims.pubkey = passkey.pubkey;
      }
      if (scopes.includes("cosekey") && passkey.cosekey) {
        claims.cosekey = passkey.cosekey;
      }

      return claims;
    },
  };
}
