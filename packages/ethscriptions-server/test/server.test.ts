import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp, SOURCE_URL, withRoutes } from "../src/index";

let upstreamCalls: string[] = [];

beforeEach(() => {
  upstreamCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      upstreamCalls.push(input instanceof Request ? input.url : String(input));
      return Response.json({ result: [{ transaction_hash: "0xabc" }], pagination: {} });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

async function home(env: Record<string, string>, title?: string) {
  const app = withRoutes(createApp(), undefined, { title });
  return (await app.request("https://api.example/", {}, env)).text();
}

describe("home page", () => {
  it("uses the default title for the title tag and the heading", async () => {
    const html = await home({});

    expect(html).toContain("<title>Calldata Ethscriptions API</title>");
    expect(html).toContain("<h1>Calldata Ethscriptions API</h1>");
  });

  it("uses a custom title", async () => {
    const html = await home({}, "Calldata Ethscriptions API (Sepolia)");

    expect(html).toContain("<title>Calldata Ethscriptions API (Sepolia)</title>");
    expect(html).toContain("<h1>Calldata Ethscriptions API (Sepolia)</h1>");
  });

  it("links the build commit and the source in monarch", async () => {
    const html = await home({ COMMIT_SHA: "abc123" });

    expect(html).toContain(
      '<a href="https://github.com/tunnckoCoreHQ/monarch/commit/abc123">abc123</a>',
    );
    expect(html).toContain(`<a href="${SOURCE_URL}">`);
  });

  it("links the repository for a local build", async () => {
    const html = await home({});

    expect(html).toContain('<a href="https://github.com/tunnckoCoreHQ/monarch">local</a>');
  });
});

describe("routes", () => {
  it("reports the source and the commit on /endpoints", async () => {
    const app = withRoutes(createApp());
    const response = await app.request("/endpoints", {}, { COMMIT_SHA: "abc123" });

    expect(await response.json()).toMatchObject({
      about: { source: SOURCE_URL, commit: "abc123" },
    });
  });

  it("forwards list requests to the given upstream", async () => {
    const app = withRoutes(createApp(), "https://upstream.example");
    const response = await app.request("/ethscriptions");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: [{ transaction_hash: "0xabc" }] });
    expect(upstreamCalls[0]).toMatch(/^https:\/\/upstream\.example\/ethscriptions/);
  });

  it("answers 400 for an invalid id", async () => {
    const response = await withRoutes(createApp()).request("/ethscriptions/0xnothex");

    expect(response.status).toBe(400);
    expect(upstreamCalls).toEqual([]);
  });

  it("turns a BigInt id into the transaction hash", async () => {
    const app = withRoutes(createApp(), "https://upstream.example");
    const id = "3305568362307615822298477236865643378946845502932415825777752632693561433502";
    await app.request(`/ethscriptions/${id}`);

    expect(upstreamCalls[0]).toContain(
      "0x074ee2a9028840b3aa8962a2eec5560f5b0a5dbfe10e67c9685057d419371d9e",
    );
  });
});

describe("JSON", () => {
  it("writes BigInt values as numbers", () => {
    expect(JSON.stringify({ block: 10n })).toBe('{"block":10}');
    expect(JSON.stringify({ a: 1n, b: 2n }, ["a"])).toBe('{"a":1}');
  });
});
