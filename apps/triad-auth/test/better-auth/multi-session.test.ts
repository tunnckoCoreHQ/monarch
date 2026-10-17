import type { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth, type HookEndpointContext } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";

import { createTriadAuth, createTriadAuthOptions } from "../../src/better-auth/auth";
import { createTriadConfiguration } from "../../src/better-auth/configuration";
import type { TriadEnv } from "../../src/better-auth/env";
import {
  createPasskeyAuthentication,
  hasOtherDeviceSession,
  withoutActiveSessionCookies,
} from "../../src/better-auth/identity";

const SECRET = "test-secret-that-is-at-least-32-characters";
const SESSION_COOKIE = "__Secure-better-auth.session_token";

function recordingDatabase(queries: string[]): D1Database {
  const meta = {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
  };
  const statement = (query: string): D1PreparedStatement => {
    const prepared: D1PreparedStatement = {
      bind: () => prepared,
      all: async () => ({ success: true, results: [], meta }),
      first: async () => null,
      raw: () => {
        throw new Error("Unexpected raw query");
      },
      run: async () => ({ success: true, results: [], meta }),
    };
    queries.push(query);

    return prepared;
  };

  return {
    prepare: statement,
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

function createEnv(database: D1Database): TriadEnv {
  return {
    ASSETS: {} as Fetcher,
    DB: database,
    AUTH_ORIGIN: "https://auth.example.com",
    BETTER_AUTH_SECRET: SECRET,
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

async function signedCookieValue(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));

  return encodeURIComponent(`${value}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`);
}

async function sessionQueries(path: string): Promise<string[]> {
  const queries: string[] = [];
  const env = createEnv(recordingDatabase(queries));
  const auth = createTriadAuth(env, createTriadConfiguration(env));
  const cookie = `${SESSION_COOKIE}=${await signedCookieValue("active-session-token")}`;

  await auth.handler(
    new Request(`https://auth.example.com/api/auth${path}`, {
      headers: { cookie, origin: "https://auth.example.com" },
    }),
  );

  return queries.filter((query) => query.includes('from "session"'));
}

const APP_CALLBACK = "https://app.example.com/callback";

function authRequest(path: string, cookie: string, body?: Record<string, unknown>): Request {
  return new Request(`https://auth.example.com/api/auth${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      cookie,
      origin: "https://auth.example.com",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function browserCookies(activeToken: string, accountTokens: string[]): Promise<string> {
  const multiCookies = await Promise.all(
    accountTokens.map(
      async (token) =>
        `${SESSION_COOKIE}_multi-${token.toLowerCase()}=${await signedCookieValue(token)}`,
    ),
  );

  return [`${SESSION_COOKIE}=${await signedCookieValue(activeToken)}`, ...multiCookies].join("; ");
}

function activeSessionToken(response: Response): string | undefined {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  const value = cookie?.slice(SESSION_COOKIE.length + 1).split(";")[0];

  return value ? decodeURIComponent(value).split(".")[0] : undefined;
}

function authorizationPath(): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: "two-account-client",
    redirect_uri: APP_CALLBACK,
    scope: "openid",
    state: "state",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
  });

  return `/oauth2/authorize?${query}`;
}

async function twoAccounts() {
  const memory = new Proxy<Record<string, unknown[]>>(
    {},
    { get: (tables, model: string) => (tables[model] ??= []) },
  );
  const env = createEnv(recordingDatabase([]));
  const auth = betterAuth({
    ...createTriadAuthOptions(env, createTriadConfiguration(env)),
    database: memoryAdapter(memory),
  });
  const context = await auth.$context;
  await context.adapter.create({
    model: "oauthClient",
    data: {
      clientId: "two-account-client",
      redirectUris: [APP_CALLBACK],
      scopes: ["openid"],
      skipConsent: true,
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  const signIn = async (provider: "google" | "twitter", digit: string) => {
    const accountSub = `acc_${digit.repeat(64)}`;
    await context.internalAdapter.createUser(
      {
        name: accountSub,
        email: `${accountSub}@identity.invalid`,
        emailVerified: false,
        provider,
        providerSub: `pid_${provider}_${digit.repeat(64)}`,
      },
      { method: provider },
    );
    const session = await context.internalAdapter.createSession(accountSub);

    return { accountSub, token: session.token };
  };

  return {
    auth,
    memory,
    google: await signIn("google", "a"),
    twitter: await signIn("twitter", "b"),
  };
}

describe("Triad multi-session", () => {
  it("keeps one signed-in account per Identity Source sign-in", () => {
    const configuration = createTriadConfiguration(createEnv(recordingDatabase([])));
    const provider = configuration.plugins.find(
      (plugin): plugin is ReturnType<typeof oauthProvider> => plugin.id === "oauth-provider",
    );

    expect(configuration.plugins.map((plugin) => plugin.id)).toContain("multi-session");
    expect(provider?.options.selectAccount?.page).toBe("/me");
  });

  it("asks for account selection only when another account is signed in", () => {
    const active = "Active-Token";
    const activeCookie = `${SESSION_COOKIE}_multi-active-token=signed`;
    const otherCookie = `${SESSION_COOKIE}_multi-other-token=signed`;

    expect(hasOtherDeviceSession(new Headers(), active)).toBe(false);
    expect(hasOtherDeviceSession(new Headers({ cookie: activeCookie }), active)).toBe(false);
    expect(
      hasOtherDeviceSession(new Headers({ cookie: `${activeCookie}; ${otherCookie}` }), active),
    ).toBe(true);
  });

  it("removes only the active session cookies", () => {
    const headers = new Headers({
      cookie: `${SESSION_COOKIE}=active; ${SESSION_COOKIE}_multi-a=one; theme=dark`,
      origin: "https://auth.example.com",
    });

    const stripped = withoutActiveSessionCookies(headers, [SESSION_COOKIE]);

    expect(stripped.get("cookie")).toBe(`${SESSION_COOKIE}_multi-a=one; theme=dark`);
    expect(stripped.get("origin")).toBe("https://auth.example.com");
    expect(headers.get("cookie")).toContain(`${SESSION_COOKIE}=active`);
  });

  it("reads the signed session for ordinary requests", async () => {
    await expect(sessionQueries("/get-session")).resolves.not.toHaveLength(0);
  });

  it("offers every discoverable passkey regardless of the active account", async () => {
    await expect(sessionQueries("/passkey/generate-authenticate-options")).resolves.toHaveLength(0);
  });

  it("registers an Identity Passkey without attaching it to the active account", async () => {
    await expect(
      sessionQueries("/passkey/generate-register-options?context=alice"),
    ).resolves.toHaveLength(0);
    await expect(
      sessionQueries("/passkey/generate-register-options?name=laptop"),
    ).resolves.not.toHaveLength(0);
  });

  it("verifies only new Identity Passkey registrations without the active account", () => {
    const hook = createPasskeyAuthentication(createEnv(recordingDatabase([]))).hooks.before[0];
    const verification = (body: Record<string, unknown>) =>
      // SAFETY: The matcher reads only the path and body of the hook context.
      hook?.matcher({ path: "/passkey/verify-registration", body } as HookEndpointContext);

    expect(verification({ response: {}, createSession: true })).toBe(true);
    expect(verification({ response: {}, name: "laptop" })).toBe(false);
  });

  it("lists, switches, and signs out of two separate accounts", async () => {
    const { auth, google, twitter } = await twoAccounts();
    const cookie = await browserCookies(google.token, [google.token, twitter.token]);

    const listed = await auth.handler(authRequest("/multi-session/list-device-sessions", cookie));
    const accounts: Array<{ user: { id: string; provider: string } }> = await listed.json();
    expect(accounts.map(({ user }) => [user.id, user.provider])).toEqual([
      [google.accountSub, "google"],
      [twitter.accountSub, "twitter"],
    ]);

    const switched = await auth.handler(
      authRequest("/multi-session/set-active", cookie, { sessionToken: twitter.token }),
    );
    expect(switched.status).toBe(200);
    expect(activeSessionToken(switched)).toBe(twitter.token);

    const twitterCookie = await browserCookies(twitter.token, [google.token, twitter.token]);
    const revoked = await auth.handler(
      authRequest("/multi-session/revoke", twitterCookie, { sessionToken: twitter.token }),
    );
    expect(revoked.status).toBe(200);
    expect(activeSessionToken(revoked)).toBe(google.token);
    await expect(
      auth.$context.then((context) => context.internalAdapter.findSession(twitter.token)),
    ).resolves.toBeNull();
  });

  it("continues an authorization with the account the person chooses", async () => {
    const { auth, memory, google, twitter } = await twoAccounts();
    const authorization = authorizationPath();

    const single = await auth.handler(
      authRequest(authorization, await browserCookies(google.token, [google.token])),
    );
    expect(single.headers.get("location")).toMatch(/^https:\/\/app\.example\.com\/callback\?/);

    const cookie = await browserCookies(google.token, [google.token, twitter.token]);
    const chooser = await auth.handler(authRequest(authorization, cookie));
    const chooserLocation = chooser.headers.get("location") ?? "";
    expect(chooserLocation).toMatch(/^\/me\?/);

    await auth.handler(
      authRequest("/multi-session/set-active", cookie, { sessionToken: twitter.token }),
    );
    const continued = await auth.handler(
      authRequest(
        "/oauth2/continue",
        await browserCookies(twitter.token, [google.token, twitter.token]),
        {
          selected: true,
          oauth_query: chooserLocation.slice("/me?".length),
        },
      ),
    );
    const { url }: { url: string } = await continued.json();
    // Better Auth stores authorization codes hashed, so the test reads the stored grants in order.
    const grants = memory.verification
      .map((row) => JSON.parse(String(Reflect.get(row as object, "value"))))
      .filter((value) => value.type === "authorization_code");

    expect(new URL(url).origin).toBe("https://app.example.com");
    expect(new URL(url).searchParams.get("code")).toBeTruthy();
    expect(grants.map(({ userId }) => userId)).toEqual([google.accountSub, twitter.accountSub]);
  });
});
