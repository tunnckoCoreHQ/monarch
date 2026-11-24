import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

import { createPublicDcrOptions, publicDcrGuard } from "../../src/better-auth/admission";

function createAuth() {
  return betterAuth({
    database: memoryAdapter({}),
    baseURL: "http://localhost",
    secret: "test-secret-that-is-at-least-32-characters",
    plugins: [
      publicDcrGuard,
      jwt(),
      oauthProvider({
        ...createPublicDcrOptions(),
        consentPage: "/consent",
        loginPage: "/sign-in",
      }),
    ],
  });
}

function register(metadata: Record<string, unknown>) {
  return createAuth().handler(
    new Request("http://localhost/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://client.example/callback"], ...metadata }),
    }),
  );
}

describe("public DCR guard", () => {
  it.each([{}, { token_endpoint_auth_method: "client_secret_basic" }])(
    "rejects an anonymous registration with metadata %j",
    async (metadata) => {
      const response = await register(metadata);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "invalid_client_metadata",
        error_description:
          'unauthenticated registration requires token_endpoint_auth_method "none"',
      });
    },
  );

  it("registers an anonymous public client without a secret", async () => {
    const response = await register({ token_endpoint_auth_method: "none" });
    const body: unknown = await response.json();

    expect(response.ok).toBe(true);
    expect(body).toMatchObject({ token_endpoint_auth_method: "none" });
    expect(body).not.toHaveProperty("client_secret");
  });

  it("keeps the anonymous client-credentials rejection", async () => {
    const response = await register({
      token_endpoint_auth_method: "none",
      grant_types: ["client_credentials"],
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_client_metadata" });
  });
});
