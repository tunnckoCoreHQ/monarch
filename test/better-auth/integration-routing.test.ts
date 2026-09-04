import { describe, expect, it, vi } from "vite-plus/test";

import type { TriadEnv } from "../../src/better-auth/env";
import { createWorker } from "../../src/index";

const context = {} as ExecutionContext;

function createEnv(overrides: Partial<TriadEnv> = {}): TriadEnv {
  return {
    ASSETS: {} as Fetcher,
    DB: {} as D1Database,
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
    ...overrides,
  };
}

function createServices() {
  const authHandler = vi.fn(() => new Response("auth"));
  const getSession = vi.fn(async () => ({ user: { id: "acc_session" } }));
  const signJWT = vi.fn(async () => ({ token: "signed-receipt" }));
  const createTriadConfiguration = vi.fn(() => ({ application: "triad" }));
  const createTriadAuth = vi.fn(() => ({ api: { getSession, signJWT }, handler: authHandler }));
  const handleWalletBroker = vi.fn(async () => new Response("wallet"));
  const handleAstro = vi.fn(async () => new Response("astro"));
  const fetchAssets = vi.fn(async () => new Response("assets"));

  return {
    services: {
      createTriadConfiguration,
      createTriadAuth,
      handleWalletBroker,
      handleAstro,
      fetchAssets,
    },
    spies: {
      authHandler,
      getSession,
      signJWT,
      createTriadConfiguration,
      createTriadAuth,
      handleWalletBroker,
      handleAstro,
      fetchAssets,
    },
  };
}

function createDeviceDatabase(record: { scope: string } | null) {
  const first = vi.fn(async () => record);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));

  return {
    database: { prepare } as unknown as D1Database,
    spies: { bind, first, prepare },
  };
}

describe("Triad protected-resource metadata routing", () => {
  it.each([
    [
      "demo",
      createEnv(),
      "https://auth.example.com/.well-known/oauth-protected-resource/demo",
      "https://auth.example.com/demo",
      [
        "openid",
        "email",
        "handle",
        "name",
        "avatar",
        "wallet",
        "chains",
        "chain_id",
        "cred",
        "pubkey",
        "cosekey",
      ],
    ],
  ])(
    "serves the configured HTTPS %s document before application routing",
    async (_name, env, metadataUrl, resource, scopes) => {
      const { services, spies } = createServices();
      const worker = createWorker(services);
      const request = new Request(metadataUrl) as Parameters<typeof worker.fetch>[0];

      const response = await worker.fetch(request, env, context);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      await expect(response.json()).resolves.toEqual({
        authorization_servers: ["https://auth.example.com/api/auth"],
        bearer_methods_supported: ["header"],
        resource,
        resource_name: "Triad demo",
        scopes_supported: scopes,
      });
      expect(spies.createTriadConfiguration).not.toHaveBeenCalled();
      expect(spies.createTriadAuth).not.toHaveBeenCalled();
      expect(spies.authHandler).not.toHaveBeenCalled();
      expect(spies.handleAstro).not.toHaveBeenCalled();
      expect(spies.fetchAssets).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://other.example.com/.well-known/oauth-protected-resource/demo/",
    "https://auth.example.com/.well-known/oauth-protected-resource/demo/?view=full",
    "https://auth.example.com/.well-known/oauth-protected-resource/unknown",
  ])("does not intercept an unconfigured metadata URL %s", async (url) => {
    const { services, spies } = createServices();
    const worker = createWorker(services);
    const request = new Request(url) as Parameters<typeof worker.fetch>[0];

    const response = await worker.fetch(request, createEnv(), context);

    expect(await response.text()).toBe("assets");
    expect(spies.fetchAssets).toHaveBeenCalledWith(request, expect.any(Object));
    expect(spies.createTriadConfiguration).not.toHaveBeenCalled();
    expect(spies.createTriadAuth).not.toHaveBeenCalled();
  });

  it("does not publish metadata for a local HTTP resource", async () => {
    const { services, spies } = createServices();
    const worker = createWorker(services);
    const request = new Request(
      "http://localhost:8787/.well-known/oauth-protected-resource/demo/",
    ) as Parameters<typeof worker.fetch>[0];

    const response = await worker.fetch(
      request,
      createEnv({ AUTH_ORIGIN: "http://localhost:8787" }),
      context,
    );

    expect(await response.text()).toBe("assets");
    expect(spies.fetchAssets).toHaveBeenCalledOnce();
  });

  it("keeps the exact Better Auth route on the auth handler", async () => {
    const { services, spies } = createServices();
    const worker = createWorker(services);
    const request = new Request("https://auth.example.com/api/auth/oauth2/authorize") as Parameters<
      typeof worker.fetch
    >[0];
    const env = createEnv();

    const response = await worker.fetch(request, env, context);

    expect(await response.text()).toBe("auth");
    expect(spies.createTriadConfiguration).toHaveBeenCalledWith(env);
    expect(spies.authHandler).toHaveBeenCalledWith(request);
    expect(spies.fetchAssets).not.toHaveBeenCalled();
  });

  it("returns canonical disclosures for the active session's bound pending device request", async () => {
    const { database, spies: databaseSpies } = createDeviceDatabase({
      scope: "openid email handle name avatar",
    });
    const { services, spies } = createServices();
    const worker = createWorker(services);
    const request = new Request(
      "https://auth.example.com/api/auth/device/disclosure?user_code=4KLF-MBB8",
    ) as Parameters<typeof worker.fetch>[0];

    const response = await worker.fetch(request, createEnv({ DB: database }), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      scopes: ["openid", "email", "handle", "name", "avatar"],
    });
    expect(spies.getSession).toHaveBeenCalledWith({ headers: request.headers });
    expect(databaseSpies.bind).toHaveBeenCalledWith("4KLFMBB8", "acc_session");
    expect(spies.authHandler).not.toHaveBeenCalled();
  });

  it("does not inspect device disclosures without an active session", async () => {
    const { database, spies: databaseSpies } = createDeviceDatabase({ scope: "openid" });
    const { services, spies } = createServices();
    spies.getSession.mockResolvedValueOnce(null as never);
    const worker = createWorker(services);
    const request = new Request(
      "https://auth.example.com/api/auth/device/disclosure?user_code=4KLF-MBB8",
    ) as Parameters<typeof worker.fetch>[0];

    const response = await worker.fetch(request, createEnv({ DB: database }), context);

    expect(response.status).toBe(401);
    expect(databaseSpies.prepare).not.toHaveBeenCalled();
  });

  it("rejects a pending device request with unsupported disclosure scopes", async () => {
    const { database } = createDeviceDatabase({ scope: "openid admin" });
    const { services } = createServices();
    const worker = createWorker(services);
    const request = new Request(
      "https://auth.example.com/api/auth/device/disclosure?user_code=4KLF-MBB8",
    ) as Parameters<typeof worker.fetch>[0];

    const response = await worker.fetch(request, createEnv({ DB: database }), context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_scope" });
  });
});
