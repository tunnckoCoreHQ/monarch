import type { oauthProvider } from "@better-auth/oauth-provider";
import type { HookEndpointContext } from "better-auth";
import { describe, expect, it } from "vitest";

import { createTriadAuth } from "../../src/better-auth/auth";
import { createTriadConfiguration } from "../../src/better-auth/configuration";
import { passkey, session, user, verification } from "../../src/better-auth/drizzle-schema";
import type { TriadEnv } from "../../src/better-auth/env";
import {
  createPasskeyAuthentication,
  hasOtherDeviceSession,
  withoutActiveSessionCookies,
} from "../../src/better-auth/identity";
import { createTestDatabase } from "../database";

const SECRET = "test-secret-that-is-at-least-32-characters";
const SESSION_COOKIE = "__Secure-better-auth.session_token";

function createEnv(database = {} as D1Database): TriadEnv {
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

const ACTIVE_ACCOUNT = `acc_${"c".repeat(64)}`;
const ACTIVE_CREDENTIAL = "active-account-credential";

// Signs one Google account in with a fresh session and one attached passkey, then sends
// the request with that session's cookie.
async function withActiveSession(path: string): Promise<Record<string, unknown> | null> {
  const { binding, database } = await createTestDatabase();
  const now = new Date();
  await database.insert(user).values({
    id: ACTIVE_ACCOUNT,
    name: ACTIVE_ACCOUNT,
    email: `${ACTIVE_ACCOUNT}@identity.invalid`,
    provider: "google",
    providerSub: `pid_google_${"c".repeat(64)}`,
  });
  await database.insert(session).values({
    id: "active-session",
    token: "active-session-token",
    userId: ACTIVE_ACCOUNT,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
    createdAt: now,
    updatedAt: now,
  });
  await database.insert(passkey).values({
    id: "active-passkey",
    publicKey: "public-key",
    userId: ACTIVE_ACCOUNT,
    credentialID: ACTIVE_CREDENTIAL,
    counter: 0,
    deviceType: "multiDevice",
    backedUp: true,
    createdAt: now,
  });
  const env = createEnv(binding);
  const auth = createTriadAuth(env, createTriadConfiguration(env));
  const cookie = `${SESSION_COOKIE}=${await signedCookieValue("active-session-token")}`;

  const response = await auth.handler(
    new Request(`https://auth.example.com/api/auth${path}`, {
      headers: { cookie, origin: "https://auth.example.com" },
    }),
  );

  return response.json();
}

function credentialIds(options: Record<string, unknown> | null, field: string): unknown[] {
  const credentials = options?.[field];

  return Array.isArray(credentials) ? credentials.map((credential) => credential.id) : [];
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
  const { binding, database } = await createTestDatabase();
  const env = createEnv(binding);
  const auth = createTriadAuth(env, createTriadConfiguration(env));
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
    database,
    google: await signIn("google", "a"),
    twitter: await signIn("twitter", "b"),
  };
}

describe("Triad multi-session", () => {
  it("keeps one signed-in account per Identity Source sign-in", () => {
    const configuration = createTriadConfiguration(createEnv());
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
    await expect(withActiveSession("/get-session")).resolves.toMatchObject({
      user: { id: ACTIVE_ACCOUNT },
    });
  });

  it("offers every discoverable passkey regardless of the active account", async () => {
    const options = await withActiveSession("/passkey/generate-authenticate-options");

    expect(options).toMatchObject({ challenge: expect.any(String) });
    expect(credentialIds(options, "allowCredentials")).toEqual([]);
  });

  it("registers an Identity Passkey without attaching it to the active account", async () => {
    const identity = await withActiveSession("/passkey/generate-register-options?context=alice");
    const attached = await withActiveSession("/passkey/generate-register-options?name=laptop");

    expect(identity).toMatchObject({ challenge: expect.any(String) });
    expect(credentialIds(identity, "excludeCredentials")).toEqual([]);
    expect(credentialIds(attached, "excludeCredentials")).toEqual([ACTIVE_CREDENTIAL]);
  });

  it("verifies only new Identity Passkey registrations without the active account", () => {
    const hook = createPasskeyAuthentication(createEnv()).hooks.before[0];
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
    const { auth, database, google, twitter } = await twoAccounts();
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
    const grants = (await database.select({ value: verification.value }).from(verification))
      .map((row) => JSON.parse(row.value))
      .filter((value) => value.type === "authorization_code");

    expect(new URL(url).origin).toBe("https://app.example.com");
    expect(new URL(url).searchParams.get("code")).toBeTruthy();
    expect(grants.map(({ userId }) => userId)).toEqual([google.accountSub, twitter.accountSub]);
  });
});
