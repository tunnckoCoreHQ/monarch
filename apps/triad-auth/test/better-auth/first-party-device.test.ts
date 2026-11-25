import { describe, expect, it } from "vitest";

import { createTriadAuth } from "../../src/better-auth/auth";
import { createTriadConfiguration } from "../../src/better-auth/configuration";
import { deviceCode } from "../../src/better-auth/drizzle-schema";
import type { TriadEnv } from "../../src/better-auth/env";
import { createTestDatabase } from "../database";

const ORIGIN = "https://auth.example.com";

function createEnv(database: D1Database): TriadEnv {
  return {
    ASSETS: {} as Fetcher,
    DB: database,
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

describe("First-party device authorization", () => {
  it("issues a device code to the triad-auth client ID on an HTTPS origin", async () => {
    const { binding, database } = await createTestDatabase();
    const env = createEnv(binding);
    const auth = createTriadAuth(env, createTriadConfiguration(env));

    const response = await auth.handler(
      new Request(`${ORIGIN}/api/auth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ client_id: "triad-auth", scope: "openid" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      device_code: expect.any(String),
      user_code: expect.any(String),
    });
    await expect(
      database
        .select({ clientId: deviceCode.clientId, status: deviceCode.status })
        .from(deviceCode),
    ).resolves.toEqual([{ clientId: "triad-auth", status: "pending" }]);
  });
});
