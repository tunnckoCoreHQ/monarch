import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { createTriadAuth } from "../../src/better-auth/auth";
import { createTriadConfiguration } from "../../src/better-auth/configuration";
import { session, walletAddress } from "../../src/better-auth/drizzle-schema";
import type { TriadEnv } from "../../src/better-auth/env";
import { createTestDatabase } from "../database";

function createEnv(database: D1Database): TriadEnv {
  return {
    ASSETS: {} as Fetcher,
    DB: database,
    AUTH_ORIGIN: "https://auth.example.com",
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
    AGENTID_CLIENT_ID: "agentid-client-id",
    AGENTID_CLIENT_SECRET: "agentid-client-secret",
  };
}

function siweRequest(path: string, body: string): Request {
  return new Request(`https://auth.example.com/api/auth${path}`, {
    method: "POST",
    headers: { origin: "https://auth.example.com", "content-type": "application/json" },
    body,
  });
}

async function createAuth() {
  const { binding, database } = await createTestDatabase();
  const env = createEnv(binding);

  return { auth: createTriadAuth(env, createTriadConfiguration(env)), database };
}

async function postSiwe(path: string, body: string): Promise<Response> {
  const { auth } = await createAuth();

  return auth.handler(siweRequest(path, body));
}

describe("SIWE request bodies", () => {
  it("issues a nonce for the empty body the account page sends", async () => {
    const response = await postSiwe("/siwe/nonce", "{}");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ nonce: expect.any(String) });
  });

  it("passes schema validation for the message and signature body the account page sends", async () => {
    const response = await postSiwe(
      "/siwe/verify",
      JSON.stringify({ message: "not a SIWE message", signature: "0x00" }),
    );

    // A strict-schema failure is 400. The 401 comes later, from the fake message.
    expect(response.status).toBe(401);
  });

  it("rejects the wallet fields the account page used to send", async () => {
    const walletFields = {
      walletAddress: "0x0000000000000000000000000000000000000001",
      chainId: 1,
    };

    const nonce = await postSiwe("/siwe/nonce", JSON.stringify(walletFields));
    const verify = await postSiwe(
      "/siwe/verify",
      JSON.stringify({ message: "not a SIWE message", signature: "0x00", ...walletFields }),
    );

    expect(nonce.status).toBe(400);
    expect(verify.status).toBe(400);
  });

  it.each([
    ["one Chain ID line", []],
    ["a later Chain ID line that is not a number", ["Chain ID: not-a-number"]],
  ])(
    "signs in with a valid wallet signature and stores the signed chain with %s",
    async (_case, trailing: string[]) => {
      const { auth, database } = await createAuth();
      const wallet = privateKeyToAccount(generatePrivateKey());

      const nonceResponse = await auth.handler(siweRequest("/siwe/nonce", "{}"));
      const { nonce }: { nonce: string } = await nonceResponse.json();
      const message = [
        "auth.example.com wants you to sign in with your Ethereum account:",
        wallet.address,
        "",
        "Sign in to Triad.",
        "",
        "URI: https://auth.example.com",
        "Version: 1",
        "Chain ID: 8453",
        `Nonce: ${nonce}`,
        `Issued At: ${new Date().toISOString()}`,
        ...trailing,
      ].join("\n");
      const signature = await wallet.signMessage({ message });

      const verifyResponse = await auth.handler(
        siweRequest("/siwe/verify", JSON.stringify({ message, signature })),
      );

      expect(verifyResponse.status).toBe(200);
      expect(verifyResponse.headers.get("set-cookie")).toContain("better-auth.session_token=");
      await expect(
        database.select({ authenticationChainId: session.authenticationChainId }).from(session),
      ).resolves.toEqual([{ authenticationChainId: 8453 }]);
      await expect(
        database.select({ chainId: walletAddress.chainId }).from(walletAddress),
      ).resolves.toEqual([{ chainId: 8453 }]);
    },
  );
});
