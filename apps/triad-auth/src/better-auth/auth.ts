import { betterAuth, env as betterAuthEnv, type BetterAuthOptions } from "better-auth";

import type { TriadEnv } from "./env";
import { validateEncryptionSecrets } from "./identity/encryption";

type FixedOption =
  | "database"
  | "baseURL"
  | "basePath"
  | "secret"
  | "secrets"
  | "trustedOrigins"
  | "emailAndPassword";

type TriadAdvancedConfiguration = Omit<
  NonNullable<BetterAuthOptions["advanced"]>,
  "disableCSRFCheck" | "disableOriginCheck"
> & {
  disableCSRFCheck?: never;
  disableOriginCheck?: never;
};

export type TriadAuthConfiguration = Omit<BetterAuthOptions, FixedOption | "advanced"> & {
  database?: never;
  baseURL?: never;
  basePath?: never;
  secret?: never;
  secrets?: never;
  trustedOrigins?: never;
  emailAndPassword?: never;
  advanced?: TriadAdvancedConfiguration;
};

export const AUTH_BASE_PATH = "/api/auth";

function normalizeAuthOrigin(origin: string): string {
  if (typeof origin !== "string") {
    throw new Error("AUTH_ORIGIN must be a valid HTTP(S) origin");
  }

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("AUTH_ORIGIN must be a valid HTTP(S) origin");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AUTH_ORIGIN must be a valid HTTP(S) origin");
  }
  const hasOnlyOptionalRootSlash = /^https?:\/\/[^\\/?#]+\/?$/i.test(origin);
  if (
    !hasOnlyOptionalRootSlash ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.href !== `${url.origin}/`
  ) {
    throw new Error("AUTH_ORIGIN must not contain credentials, a path, query, or hash");
  }

  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !isLoopback) {
    throw new Error("AUTH_ORIGIN must use HTTPS unless it is local");
  }

  return url.origin;
}

function validateSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  }
}

function validateStrongSecret(
  name: "IDENTIFIER_SECRET" | "RATE_LIMIT_SECRET",
  secret: string,
): void {
  if (
    typeof secret !== "string" ||
    secret.length < 32 ||
    secret.trim() !== secret ||
    new Set(secret).size < 16 ||
    /^(.)\1+$/.test(secret)
  ) {
    throw new Error(`${name} must be a strong, non-whitespace secret with at least 32 characters`);
  }
}

function validateIndependentSecrets(env: TriadEnv): void {
  const secrets = [env.BETTER_AUTH_SECRET, env.IDENTIFIER_SECRET, env.RATE_LIMIT_SECRET];
  if (new Set(secrets).size !== secrets.length) {
    throw new Error(
      "BETTER_AUTH_SECRET, IDENTIFIER_SECRET, and RATE_LIMIT_SECRET must use independent values",
    );
  }
}

function rejectAmbientOverrides(): void {
  const forbiddenNames = ["BETTER_AUTH_SECRETS", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;

  for (const name of forbiddenNames) {
    if (betterAuthEnv[name]) {
      throw new Error(`${name} must not be set`);
    }
  }
}

export function createTriadAuthOptions<const Configuration extends TriadAuthConfiguration>(
  env: TriadEnv,
  configuration?: Configuration,
) {
  rejectAmbientOverrides();
  validateSecret(env.BETTER_AUTH_SECRET);
  validateStrongSecret("IDENTIFIER_SECRET", env.IDENTIFIER_SECRET);
  validateStrongSecret("RATE_LIMIT_SECRET", env.RATE_LIMIT_SECRET);
  validateIndependentSecrets(env);
  validateEncryptionSecrets(env.ENCRYPTION_SECRETS, [
    env.IDENTIFIER_SECRET,
    env.RATE_LIMIT_SECRET,
    env.BETTER_AUTH_SECRET,
  ]);
  const baseURL = normalizeAuthOrigin(env.AUTH_ORIGIN);

  const {
    database: _database,
    baseURL: _baseURL,
    basePath: _basePath,
    secret: _secret,
    secrets: _secrets,
    trustedOrigins: _trustedOrigins,
    emailAndPassword: _emailAndPassword,
    advanced,
    ...permittedConfiguration
  } = configuration ?? ({} as Configuration);
  const {
    disableCSRFCheck: _disableCSRFCheck,
    disableOriginCheck: _disableOriginCheck,
    ...permittedAdvanced
  } = advanced ?? {};

  return {
    ...permittedConfiguration,
    database: env.DB,
    baseURL,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    secrets: undefined,
    trustedOrigins: [baseURL],
    emailAndPassword: { enabled: false },
    advanced: {
      ...permittedAdvanced,
      disableCSRFCheck: false,
      disableOriginCheck: false,
    },
  };
}

export function createTriadAuth<const Configuration extends TriadAuthConfiguration>(
  env: TriadEnv,
  configuration?: Configuration,
) {
  return betterAuth(createTriadAuthOptions(env, configuration));
}
