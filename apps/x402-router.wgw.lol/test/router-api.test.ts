import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { routerApi } from "../src/router-api";

const origin = "https://x402-router.wgw.lol";

describe("routerApi", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["/health", "/healthz", "/health/", "/healthz/"])(
    "adds the build commit to GET %s",
    async (path) => {
      vi.stubEnv("COMMIT_SHA", "abc1234");

      const response = await routerApi(new Request(`${origin}${path}`));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      await expect(response.json()).resolves.toEqual({
        ok: true,
        service: "@tunnckocore/x402-router",
        commit: "abc1234",
      });
    },
  );

  it("leaves non-health responses untouched", async () => {
    vi.stubEnv("COMMIT_SHA", "abc1234");

    const response = await routerApi(new Request(`${origin}/nope`));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("leaves non-GET health requests untouched", async () => {
    vi.stubEnv("COMMIT_SHA", "abc1234");

    const response = await routerApi(new Request(`${origin}/health`, { method: "OPTIONS" }));

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
});
