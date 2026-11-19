import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";

const env = { COMMIT_SHA: "abc123" };

const upstreams: Record<string, string> = {
  "api.ethscriptions.com": "0xmainnet",
  "sepolia-api-v2.ethscriptions.com": "0xsepolia",
};

let upstreamCalls: string[] = [];
let upstreamEmpty = false;
let pending: Array<Promise<unknown>> = [];

// A Map stands in for the Workers cache; the tests run in Node, not workerd.
function memoryCache() {
  const store = new Map<string, Response>();
  return {
    match: async (request: Request) => store.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => {
      store.set(request.url, response);
    },
  };
}

async function request(url: string) {
  // SAFETY: the Worker only calls waitUntil on the context.
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
  } as ExecutionContext;
  // SAFETY: the Worker never reads request.cf.
  const incoming = new Request(url) as Parameters<typeof worker.fetch>[0];

  const response = await worker.fetch(incoming, env, ctx);
  await Promise.all(pending);
  return response;
}

async function firstHash(url: string) {
  // SAFETY: the upstream stub always answers with a result list.
  const body: { result: Array<{ transaction_hash: string }> } = await (await request(url)).json();
  return body.result[0]?.transaction_hash;
}

async function title(url: string) {
  return /<title>(.*)<\/title>/.exec(await (await request(url)).text())?.[1];
}

beforeEach(() => {
  upstreamCalls = [];
  upstreamEmpty = false;
  pending = [];
  const cache = memoryCache();
  vi.stubGlobal("caches", { open: async () => cache });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      upstreamCalls.push(url.hostname);
      const hash = upstreams[url.hostname] ?? "0xunknown";
      const result = upstreamEmpty ? [] : [{ transaction_hash: hash }];
      return Response.json({ result, pagination: {} });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("routing", () => {
  it.each([
    ["https://api.calldata.space/ethscriptions", "0xmainnet"],
    ["https://api.calldata.space/mainnet/ethscriptions", "0xmainnet"],
    ["https://api.calldata.space/sepolia/ethscriptions", "0xsepolia"],
    ["https://sepolia-api.calldata.space/ethscriptions", "0xsepolia"],
  ])("%s serves %s", async (url, hash) => {
    expect(await firstHash(url)).toBe(hash);
  });

  it.each([
    ["https://api.calldata.space/", "Calldata API"],
    ["https://api.calldata.space/mainnet", "Calldata API"],
    ["https://api.calldata.space/sepolia", "Calldata API (Sepolia)"],
    ["https://sepolia-api.calldata.space/", "Calldata API (Sepolia)"],
  ])("%s has the title %s", async (url, expected) => {
    expect(await title(url)).toBe(expected);
  });

  it("shows the deployed commit", async () => {
    const home = await (await request("https://api.calldata.space/")).text();
    const llms = await (await request("https://api.calldata.space/llms.txt")).text();

    expect(home).toContain("Build: <a");
    expect(home).toContain(">abc123</a>");
    expect(llms).toContain("Build: abc123");
    expect(llms).toContain(
      "Source: https://github.com/tunnckoCoreHQ/monarch/tree/master/apps/ethscriptions-api-proxy",
    );
  });
});

describe("cache", () => {
  it("serves a repeated GET from the cache", async () => {
    await firstHash("https://api.calldata.space/ethscriptions");
    await firstHash("https://api.calldata.space/ethscriptions");

    expect(upstreamCalls).toEqual(["api.ethscriptions.com"]);
  });

  it("keeps mainnet and Sepolia apart", async () => {
    expect(await firstHash("https://api.calldata.space/ethscriptions")).toBe("0xmainnet");
    expect(await firstHash("https://api.calldata.space/sepolia/ethscriptions")).toBe("0xsepolia");
  });

  it("never caches a 404", async () => {
    // An empty upstream list is a 404 from the server.
    upstreamEmpty = true;
    const first = await request("https://api.calldata.space/ethscriptions");
    const second = await request("https://api.calldata.space/ethscriptions");

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(upstreamCalls).toHaveLength(2);
  });
});
