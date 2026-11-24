import { describe, expect, it } from "vitest";

import { createTriadAuth } from "../../src/better-auth/auth";
import { createTriadConfiguration } from "../../src/better-auth/configuration";
import type { TriadEnv } from "../../src/better-auth/env";

const ORIGIN = "https://auth.example.com";
const meta = {
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changed_db: false,
  changes: 0,
};

function createStatement(query: string): D1PreparedStatement {
  let values: unknown[] = [];
  const statement: D1PreparedStatement = {
    bind: (...bound: unknown[]) => {
      values = bound;

      return statement;
    },
    all: async () => ({ success: true, results: [], meta }),
    first: async () => null,
    // SAFETY: Drizzle reads each returned row as positional column values.
    raw: (async () => (query.startsWith("insert") ? [values] : [])) as D1PreparedStatement["raw"],
    run: async () => ({ success: true, results: [], meta }),
  };

  return statement;
}

function createEnv(): TriadEnv {
  return {
    ASSETS: {} as Fetcher,
    DB: {
      prepare: createStatement,
      async batch<T = unknown>(statements: D1PreparedStatement[]) {
        const allowed = { success: true as const, results: [{ lastRequest: 0 }], meta };

        return statements.map(() => allowed) as Array<D1Result<T>>;
      },
      exec: async () => ({ count: 0, duration: 0 }),
      withSession: () => {
        throw new Error("Unexpected session");
      },
      dump: () => {
        throw new Error("Unexpected dump");
      },
    },
    AUTH_ORIGIN: ORIGIN,
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
    AGENTID_CLIENT_ID: "",
    AGENTID_CLIENT_SECRET: "",
  };
}

describe("First-party device authorization on an HTTPS origin", () => {
  it("issues a device code to Triad's own origin", async () => {
    const env = createEnv();
    const auth = createTriadAuth(env, createTriadConfiguration(env));

    const response = await auth.handler(
      new Request(`${ORIGIN}/api/auth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ client_id: ORIGIN, scope: "openid" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      device_code: expect.any(String),
      user_code: expect.any(String),
    });
  });
});
