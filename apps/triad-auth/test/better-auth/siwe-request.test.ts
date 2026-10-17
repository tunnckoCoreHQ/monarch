import { readFileSync, readdirSync } from "node:fs";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { createTriadAuth, createTriadAuthOptions } from "../../src/better-auth/auth";
import { createTriadConfiguration } from "../../src/better-auth/configuration";
import type { TriadEnv } from "../../src/better-auth/env";

const meta = {
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changed_db: false,
  changes: 0,
};

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

function migratedTables(): string[] {
  const statements = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => readFileSync(new URL(file, MIGRATIONS), "utf-8"))
    .join("\n");

  return [...statements.matchAll(/create table "(\w+)"/g)].map(([, table]) => table ?? "");
}

function emptyDatabase(): D1Database {
  const statement: D1PreparedStatement = {
    bind: () => statement,
    all: async () => ({ success: true, results: [], meta }),
    first: async () => null,
    raw: () => {
      throw new Error("Unexpected raw query");
    },
    run: async () => ({ success: true, results: [], meta }),
  };

  return {
    prepare: () => statement,
    // The rate limiter reads one allowed bucket row from each batch result.
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
  };
}

function createEnv(): TriadEnv {
  return {
    ASSETS: {} as Fetcher,
    DB: emptyDatabase(),
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

async function postSiwe(path: string, body: string): Promise<Response> {
  const env = createEnv();
  const auth = createTriadAuth(env, createTriadConfiguration(env));

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
      // The memory adapter copies plain arrays during a transaction and needs every
      // migrated table up front.
      const memory: Record<string, Array<Record<string, unknown>>> = Object.fromEntries(
        migratedTables().map((table) => [table, []]),
      );
      const env = createEnv();
      const auth = betterAuth({
        ...createTriadAuthOptions(env, createTriadConfiguration(env)),
        database: memoryAdapter(memory),
      });
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
      expect(memory.session).toHaveLength(1);
      expect(memory.session[0]).toMatchObject({ authenticationChainId: 8453 });
      expect(memory.walletAddress[0]).toMatchObject({ chainId: 8453 });
    },
  );
});
