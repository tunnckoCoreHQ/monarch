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

  it("checks /sha existence on the given upstream", async () => {
    const app = withRoutes(createApp(), "https://upstream.example");
    await app.request("/sha?of=data:,wgw");
    await app.request("/sha", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "data:,wgw", checkExists: true }),
    });

    expect(upstreamCalls).toHaveLength(2);
    for (const url of upstreamCalls) {
      expect(url).toMatch(/^https:\/\/upstream\.example\//);
    }
  });

  it.each([
    ["?creator=true", "0xcreator"],
    ["?checkCreator=true", "0xcreator"],
    ["?creator=false", "0xowner"],
    ["?checkCreator=false", "0xowner"],
    ["", "0xowner"],
  ])("resolves /resolve/wgw%s to %s", async (query, address) => {
    // ENS has no match, so the name resolves through its ethscription.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).includes("/ethscriptions/exists/")
          ? Response.json({
              result: {
                exists: true,
                ethscription: { creator: "0xCreator", current_owner: "0xOwner" },
              },
            })
          : Response.json({}),
      ),
    );
    const response = await withRoutes(createApp()).request(`/resolve/wgw${query}`);

    expect(await response.json()).toMatchObject({ result: { address } });
  });

  it("applies snake_case price options to /estimate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            blockNr: "1",
            ethPrice: 2000,
            baseFee: 1,
            nextFee: 1,
            oracle: { normal: { gwei: 2, gasFee: 2, priorityFee: 2 } },
          },
        }),
      ),
    );
    const app = withRoutes(createApp());
    const get = await app.request("/estimate/data:,wgw?eth_price=4000&gas_price=10");
    const post = await app.request("/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "data:,wgw", eth_price: 4000, gas_price: 10 }),
    });

    for (const response of [get, post]) {
      expect(await response.json()).toMatchObject({
        result: { prices: { eth_price: 4000, gas_price: 10 } },
      });
    }
  });

  it("uses a baseURL query param as the upstream on the list route", async () => {
    const app = withRoutes(createApp(), "https://upstream.example");
    await app.request("/ethscriptions?baseURL=https://other.example");

    expect(upstreamCalls[0]).toMatch(/^https:\/\/other\.example\/ethscriptions/);
  });

  it("does not resolve names when the query says resolve=false", async () => {
    const app = withRoutes(createApp(), "https://upstream.example");
    await app.request("/ethscriptions?resolve=false&current_owner=wgw");

    expect(upstreamCalls.some((url) => url.includes("ensdata.net"))).toBe(false);
  });

  it("keeps repeated query keys on the profile route", async () => {
    const app = withRoutes(createApp(), "https://upstream.example");
    await app.request(
      "/profiles/0x0000000000000000000000000000000000000001/owned?sort_order=asc&sort_order=desc",
    );

    expect(upstreamCalls[0]).toContain("sort_order=asc&sort_order=desc");
  });

  it("lowercases a 0x transaction hash, like the old schema did", async () => {
    const app = withRoutes(createApp(), "https://upstream.example");
    await app.request(
      "/ethscriptions/0x074EE2A9028840B3AA8962A2EEC5560F5B0A5DBFE10E67C9685057D419371D9E",
    );

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

  it("keeps array items with a key whitelist, like the native one", () => {
    const value = { rows: [{ id: 1n, skip: 2 }], skip: 3 };

    expect(JSON.stringify(value, ["rows", "id"])).toBe('{"rows":[{"id":1}]}');
  });
});
