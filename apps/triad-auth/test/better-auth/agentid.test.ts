import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTriadAuthOptions } from "../../src/better-auth/auth";
import { createTriadConfiguration } from "../../src/better-auth/configuration";
import type { TriadEnv } from "../../src/better-auth/env";
import {
  accountSubject,
  createAgentIdAuthentication,
  openProfileEncryptedData,
  providerSubject,
} from "../../src/better-auth/identity";

const ORIGIN = "https://auth.example.com";
const IDENTIFIER_SECRET = "identifier-secret-with-enough-entropy-1234567890";
const AGENT_SUB = "lM9vT2aR7sK4qN8wE1xC6bY0uF3hJ5pD9gL2zV7oA4Q";

function createEnv(overrides: Partial<TriadEnv> = {}): TriadEnv {
  return {
    ASSETS: {} as Fetcher,
    DB: {} as D1Database,
    AUTH_ORIGIN: ORIGIN,
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
    IDENTIFIER_SECRET,
    RATE_LIMIT_SECRET: "rate-limit-secret-with-enough-entropy-1234567890",
    ENCRYPTION_SECRETS:
      '{"active":"v1","secrets":{"v1":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}}',
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    GITHUB_CLIENT_ID: "",
    GITHUB_CLIENT_SECRET: "",
    TWITTER_CLIENT_ID: "",
    TWITTER_CLIENT_SECRET: "",
    AGENTID_CLIENT_ID: "agentid-client-id",
    AGENTID_CLIENT_SECRET: "agentid-client-secret",
    ...overrides,
  };
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

const AGENT_PROFILE = {
  sub: AGENT_SUB,
  email: "agent@agentmail.to",
  email_verified: true,
  name: "Research Agent",
  preferred_username: "agent_agentmail-to",
  owner_sub: "oW7xN2pQ4mT8vL1kR6sC9dF3gH5jB0aE2uY4zI6nP8A",
};

// AgentID's token and userinfo endpoints, as documented at https://www.agentid.com/docs.
function agentIdServer(userinfo: () => Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === "https://auth.agentid.com/v0/token") {
      const body = new URLSearchParams(await request.text());
      expect(request.headers.get("authorization")).toBe(
        `Basic ${btoa("agentid-client-id:agentid-client-secret")}`,
      );
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("agentid-code");
      expect(body.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/agentid`);
      expect(body.get("code_verifier")).toBeTruthy();

      return Response.json({
        access_token: "agentid-access-token",
        token_type: "Bearer",
        expires_in: 600,
        id_token: "not.read.by-triad",
      });
    }
    if (request.url === "https://auth.agentid.com/v0/userinfo") {
      expect(request.headers.get("authorization")).toBe("Bearer agentid-access-token");

      return userinfo();
    }

    throw new Error(`Unexpected request to ${request.url}`);
  });
}

// Starts an AgentID sign-in on a fresh Triad, then returns to its callback with a code.
async function signInThroughAgentId(
  userinfo: () => Response = () => Response.json(AGENT_PROFILE),
  iss = "https://auth.agentid.com",
) {
  const memory: Record<string, Array<Record<string, unknown>>> = {
    user: [],
    account: [],
    session: [],
    verification: [],
    oauthResource: [],
  };
  const env = createEnv();
  const auth = betterAuth({
    ...createTriadAuthOptions(env, createTriadConfiguration(env)),
    database: memoryAdapter(memory),
    rateLimit: { enabled: false },
  });

  const start = await auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ provider: "agentid", callbackURL: `${ORIGIN}/me` }),
    }),
  );
  const { url } = await start.json<{ url: string }>();
  const authorization = new URL(url);

  const server = agentIdServer(userinfo);
  vi.stubGlobal("fetch", server);
  const state = authorization.searchParams.get("state") ?? "";
  const callback = await auth.handler(
    new Request(
      `${ORIGIN}/api/auth/callback/agentid?code=agentid-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(iss)}`,
      { headers: { cookie: cookieHeader(start) } },
    ),
  );

  return { authorization, callback, env, memory, server, start };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentID Identity Source", () => {
  it("registers AgentID with fixed endpoints only when both credentials are set", () => {
    expect(createAgentIdAuthentication(createEnv()).options.config).toMatchObject([
      {
        providerId: "agentid",
        clientId: "agentid-client-id",
        clientSecret: "agentid-client-secret",
        authentication: "basic",
        authorizationUrl: "https://auth.agentid.com/v0/authorize",
        tokenUrl: "https://auth.agentid.com/v0/token",
        accountIssuer: "https://auth.agentid.com",
        scopes: ["openid", "email", "profile"],
      },
    ]);
    expect(createAgentIdAuthentication(createEnv()).options.config[0]).not.toHaveProperty(
      "discoveryUrl",
    );
    expect(
      createAgentIdAuthentication(createEnv({ AGENTID_CLIENT_SECRET: " " })).options.config,
    ).toEqual([]);
  });

  it("signs an agent in to a Triad Account through the AgentID code flow", async () => {
    const { authorization, callback, env, memory, server, start } = await signInThroughAgentId(() =>
      Response.json(AGENT_PROFILE),
    );

    expect(start.status).toBe(200);
    expect(`${authorization.origin}${authorization.pathname}`).toBe(
      "https://auth.agentid.com/v0/authorize",
    );
    expect(Object.fromEntries(authorization.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "agentid-client-id",
      redirect_uri: `${ORIGIN}/api/auth/callback/agentid`,
      scope: "openid email profile",
      code_challenge_method: "S256",
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`${ORIGIN}/me`);
    expect(server).toHaveBeenCalledTimes(2);

    const accountSub = await accountSubject(IDENTIFIER_SECRET, "agentid", AGENT_SUB);
    expect(memory.user).toMatchObject([
      {
        id: accountSub,
        name: "",
        email: `${accountSub}@identity.invalid`,
        emailVerified: false,
        provider: "agentid",
        providerSub: await providerSubject(IDENTIFIER_SECRET, "agentid", AGENT_SUB),
        encryptedData: expect.any(String),
      },
    ]);
    expect(JSON.stringify(memory.user)).not.toContain("agent@agentmail.to");
    await expect(
      openProfileEncryptedData(
        env.ENCRYPTION_SECRETS,
        accountSub,
        String(memory.user[0]?.encryptedData),
      ),
    ).resolves.toEqual({
      profileEmail: "agent@agentmail.to",
      profileEmailVerified: true,
      profileHandle: "agent_agentmail-to",
      profileDisplayName: "Research Agent",
    });
    expect(memory.account).toMatchObject([
      {
        providerId: "agentid",
        issuer: "https://auth.agentid.com",
        accountId: AGENT_SUB,
        userId: accountSub,
        accessToken: null,
        refreshToken: null,
        idToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
      },
    ]);
  });

  it.each([
    [
      "is not JSON",
      () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    ],
    [
      "cannot be reached",
      () => {
        throw new TypeError("network error");
      },
    ],
  ])("fails the sign-in cleanly when AgentID userinfo %s", async (_case, userinfo) => {
    const { callback, memory } = await signInThroughAgentId(userinfo);

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("error=unable_to_get_user_info");
    expect(memory.user).toEqual([]);
    expect(memory.account).toEqual([]);
  });

  it("rejects a callback whose iss is not AgentID before redeeming the code", async () => {
    const { callback, memory, server } = await signInThroughAgentId(
      undefined,
      "https://attacker.example",
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("error=issuer_mismatch");
    expect(server).not.toHaveBeenCalled();
    expect(memory.user).toEqual([]);
    expect(memory.account).toEqual([]);
  });
});
