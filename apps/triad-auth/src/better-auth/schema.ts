import { createTriadAuth } from "./auth";
import { createTriadConfiguration } from "./configuration";
import type { TriadEnv } from "./env";

const schemaEnv = {
  // SAFETY: Schema generation constructs auth options without serving static assets.
  ASSETS: {} as Fetcher,
  // SAFETY: Schema generation reads the auth options only. The Drizzle adapter sends no query to this binding.
  DB: {} as D1Database,
  AUTH_ORIGIN: "http://localhost",
  BETTER_AUTH_SECRET: "schema-only-secret-that-is-at-least-32-characters",
  IDENTIFIER_SECRET: "schema-identifier-secret-with-enough-entropy-123456",
  RATE_LIMIT_SECRET: "schema-rate-limit-secret-with-enough-entropy-123456",
  ENCRYPTION_SECRETS:
    '{"active":"v1","secrets":{"v1":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}}',
  GOOGLE_CLIENT_ID: "schema-google-client-id",
  GOOGLE_CLIENT_SECRET: "schema-google-client-secret",
  GITHUB_CLIENT_ID: "schema-github-client-id",
  GITHUB_CLIENT_SECRET: "schema-github-client-secret",
  TWITTER_CLIENT_ID: "schema-twitter-client-id",
  TWITTER_CLIENT_SECRET: "schema-twitter-client-secret",
  AGENTID_CLIENT_ID: "schema-agentid-client-id",
  AGENTID_CLIENT_SECRET: "schema-agentid-client-secret",
} satisfies TriadEnv;

const configuration = createTriadConfiguration(schemaEnv);

export const auth = createTriadAuth(schemaEnv, configuration);
