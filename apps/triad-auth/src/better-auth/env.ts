export interface TriadEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  AUTH_ORIGIN: string;
  BETTER_AUTH_SECRET: string;
  IDENTIFIER_SECRET: string;
  RATE_LIMIT_SECRET: string;
  ENCRYPTION_SECRETS: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  TWITTER_CLIENT_ID: string;
  TWITTER_CLIENT_SECRET: string;
}
