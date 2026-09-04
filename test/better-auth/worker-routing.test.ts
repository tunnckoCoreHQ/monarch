import { describe, expect, it, vi } from "vite-plus/test";

import type { TriadEnv } from "../../src/better-auth/env";
import { createWorker, isAuthPath } from "../../src/index";

const env = {} as TriadEnv;
const context = {} as ExecutionContext;

function createServices() {
  const calls: string[] = [];
  const configuration = { application: "triad" };

  const authHandler = vi.fn(() => new Response("auth"));
  const getSession = vi.fn(async () => null);
  const signJWT = vi.fn(async () => ({ token: "signed-receipt" }));
  const createTriadConfiguration = vi.fn(() => {
    calls.push("configuration");

    return configuration;
  });
  const createTriadAuth = vi.fn((_env: TriadEnv, receivedConfiguration: typeof configuration) => {
    calls.push("auth");
    expect(receivedConfiguration).toBe(configuration);

    return { api: { getSession, signJWT }, handler: authHandler };
  });
  const handleWalletBroker = vi.fn(async () => {
    calls.push("wallet");

    return new Response("wallet");
  });
  const handleAstro = vi.fn(async () => {
    calls.push("astro");

    return new Response("astro");
  });
  const fetchAssets = vi.fn(async () => {
    calls.push("assets");

    return new Response("assets");
  });

  return {
    calls,
    configuration,
    services: {
      createTriadConfiguration,
      createTriadAuth,
      handleWalletBroker,
      handleAstro,
      fetchAssets,
    },
    spies: {
      createTriadConfiguration,
      createTriadAuth,
      authHandler,
      getSession,
      signJWT,
      handleWalletBroker,
      handleAstro,
      fetchAssets,
    },
  };
}

describe("isAuthPath", () => {
  it.each([
    ["/api/auth", true],
    ["/api/auth/session", true],
    ["/api/authentic", false],
    ["/api/auth-example/session", false],
    ["/", false],
  ])("matches %s: %s", (pathname, expected) => {
    expect(isAuthPath(pathname)).toBe(expected);
  });
});

describe("Triad Worker routing", () => {
  it.each(["/api/auth", "/api/auth/session"])(
    "routes %s through configuration and auth only",
    async (pathname) => {
      const { calls, configuration, services, spies } = createServices();
      const worker = createWorker(services);
      const request = new Request(`https://auth.example.com${pathname}`) as Parameters<
        typeof worker.fetch
      >[0];

      const response = await worker.fetch(request, env, context);

      expect(await response.text()).toBe("auth");
      expect(calls).toEqual(["configuration", "auth"]);
      expect(spies.createTriadConfiguration).toHaveBeenCalledWith(env);
      expect(spies.createTriadAuth).toHaveBeenCalledWith(env, configuration);
      expect(spies.authHandler).toHaveBeenCalledWith(request);
      expect(spies.handleAstro).not.toHaveBeenCalled();
      expect(spies.fetchAssets).not.toHaveBeenCalled();
    },
  );

  it("routes an auth-like path through assets only", async () => {
    const { calls, services, spies } = createServices();
    const worker = createWorker(services);
    const request = new Request("https://auth.example.com/api/authentic") as Parameters<
      typeof worker.fetch
    >[0];

    const response = await worker.fetch(request, env, context);

    expect(await response.text()).toBe("assets");
    expect(calls).toEqual(["assets"]);
    expect(spies.fetchAssets).toHaveBeenCalledWith(request, env);
    expect(spies.createTriadConfiguration).not.toHaveBeenCalled();
    expect(spies.createTriadAuth).not.toHaveBeenCalled();
    expect(spies.authHandler).not.toHaveBeenCalled();
    expect(spies.handleAstro).not.toHaveBeenCalled();
  });

  it("routes wallet broker endpoints through authenticated configuration", async () => {
    const { calls, configuration, services, spies } = createServices();
    const worker = createWorker(services);
    const request = new Request("https://auth.example.com/api/wallet/inspect", {
      method: "POST",
    }) as Parameters<typeof worker.fetch>[0];

    const response = await worker.fetch(request, env, context);

    expect(await response.text()).toBe("wallet");
    expect(calls).toEqual(["configuration", "auth", "wallet"]);
    expect(spies.createTriadAuth).toHaveBeenCalledWith(env, configuration);
    expect(spies.handleWalletBroker).toHaveBeenCalledWith(request, env, expect.any(Object));
    expect(spies.authHandler).not.toHaveBeenCalled();
    expect(spies.fetchAssets).not.toHaveBeenCalled();
  });

  it("routes Astro internals through Astro only", async () => {
    const { calls, services, spies } = createServices();
    const worker = createWorker(services);
    const request = new Request("https://auth.example.com/__astro_page") as Parameters<
      typeof worker.fetch
    >[0];

    const response = await worker.fetch(request, env, context);

    expect(await response.text()).toBe("astro");
    expect(calls).toEqual(["astro"]);
    expect(spies.handleAstro).toHaveBeenCalledWith(request, env, context);
    expect(spies.createTriadConfiguration).not.toHaveBeenCalled();
    expect(spies.createTriadAuth).not.toHaveBeenCalled();
    expect(spies.authHandler).not.toHaveBeenCalled();
    expect(spies.fetchAssets).not.toHaveBeenCalled();
  });

  it.each([
    ["/api/auth/oauth2/authorize", "unsafe-none"],
    ["/api/auth/callback/google", "unsafe-none"],
    ["/consent", "unsafe-none"],
    ["/consent/", "unsafe-none"],
    ["/me/", "same-origin"],
  ])("sets the route-specific opener policy for %s", async (pathname, expectedPolicy) => {
    const { services } = createServices();
    const worker = createWorker(services);
    const request = new Request(`https://auth.example.com${pathname}`) as Parameters<
      typeof worker.fetch
    >[0];

    const response = await worker.fetch(request, env, context);

    expect(response.headers.get("cross-origin-opener-policy")).toBe(expectedPolicy);
  });
});
