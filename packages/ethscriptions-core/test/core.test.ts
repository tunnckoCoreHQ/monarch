import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bytesToHex,
  checkExists,
  estimateDataCost,
  getAllEthscriptions,
  getDigestForData,
  getEthscriptionById,
  getEthscriptionDetailed,
  getUserProfile,
  hexToBytes,
  isEthereumAddress,
  isHexValue,
  namesResolver,
  normalizeAndSortTransfers,
  searchParamsToOptions,
} from "../src/index";
import type { UpstreamTransfer } from "../src/types";

const TX_HASH = "0x35d1a4680e450eb8766f966f5182ba171f247c91b06e79e70da383e760094203";
const FOOBAR_SHA = "daf733bdb187b0b64c7cc39adc45d4516dbc8786db9958d5151d6c80b24af63b";

const upstreamEthscription = {
  transaction_hash: TX_HASH,
  block_number: "26452429",
  transaction_index: "254",
  block_timestamp: "1795131011",
  block_blockhash: "0x2412d6d7f169a405b7c1a2f9005daf7cde6965b455d02b08a2070951284f8486",
  event_log_index: null,
  ethscription_number: "16826506",
  creator: "0x34d6bb3280d2f4ef25ff14801e0838dba76ae664",
  initial_owner: "0x342bf88482af5e58c8e2868cd8366d4e571c0a21",
  current_owner: "0x342bf88482af5e58c8e2868cd8366d4e571c0a21",
  previous_owner: "0x34d6bb3280d2f4ef25ff14801e0838dba76ae664",
  content_uri: "data:,foobar",
  content_sha: `0x${FOOBAR_SHA}`,
  esip6: false,
  mimetype: "text/plain",
  media_type: "text",
  mime_subtype: "plain",
  gas_price: "210220580",
  gas_used: "26480",
  transaction_fee: "5566640958400",
  value: "0",
  attachment_sha: null,
  attachment_content_type: null,
  ethscription_transfers: [],
};

const gasPrices = {
  data: {
    blockNr: "26452452",
    ethPrice: 2000,
    baseFee: 1,
    nextFee: 1,
    oracle: {
      slow: { gwei: 1, gasFee: 1, priorityFee: 1 },
      normal: { gwei: 2, gasFee: 2, priorityFee: 2 },
      fast: { gwei: 3, gasFee: 3, priorityFee: 3 },
    },
  },
};

let calls: Array<{ url: string; init?: RequestInit }> = [];

function stubFetch(answer: (url: string) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      return Response.json(answer(url));
    }),
  );
}

beforeEach(() => {
  calls = [];
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getAllEthscriptions", () => {
  it("fetches the list from the given baseURL and normalizes each result", async () => {
    stubFetch(() => ({
      result: [upstreamEthscription],
      pagination: { has_more: false, page_key: TX_HASH },
    }));

    const res = await getAllEthscriptions({
      baseURL: "https://upstream.example",
      media_type: "text",
      per_page: 1,
    });

    expect(calls[0]?.url).toBe(
      "https://upstream.example/ethscriptions?media_type=text&per_page=1&max_results=1",
    );
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }

    expect(res.pagination).toEqual({ has_more: false, page_key: TX_HASH });
    expect(res.result[0]).toMatchObject({
      transaction_hash: TX_HASH,
      block_number: 26_452_429,
      transaction_fee: 5_566_640_958_400n,
      receiver: upstreamEthscription.initial_owner,
      content_type: "text/plain",
      content_path: `/ethscriptions/${TX_HASH}/content`,
      is_esip0: true,
      is_esip8: false,
    });
  });

  it("answers 404 for an empty list", async () => {
    stubFetch(() => ({ result: [] }));

    const res = await getAllEthscriptions({ baseURL: "https://upstream.example" });

    expect(res).toMatchObject({ ok: false, error: { code: "NOT_FOUND", httpStatus: 404 } });
  });
});

describe("getEthscriptionById", () => {
  it("fetches one ethscription by id", async () => {
    stubFetch(() => ({ result: upstreamEthscription }));

    const res = await getEthscriptionById(TX_HASH, { baseURL: "https://upstream.example" });

    expect(calls[0]?.url).toBe(`https://upstream.example/ethscriptions/${TX_HASH}`);
    expect(res).toMatchObject({ ok: true, result: { transaction_hash: TX_HASH } });
  });

  it("keeps only the asked fields", async () => {
    stubFetch(() => ({ result: upstreamEthscription }));

    const res = await getEthscriptionById("16826506", {
      baseURL: "https://upstream.example",
      with: "content_uri",
      only: "transaction_hash,creator",
    });

    expect(res.ok && res.result).toEqual({
      transaction_hash: TX_HASH,
      creator: upstreamEthscription.creator,
      content_uri: "data:,foobar",
    });
  });

  it("answers with the upstream status when the upstream fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );

    const res = await getEthscriptionById(TX_HASH);

    expect(res).toMatchObject({ ok: false, error: { httpStatus: 404 } });
  });
});

describe("getDigestForData", () => {
  it("hashes a data URI", async () => {
    const res = await getDigestForData("data:,foobar");

    expect(res).toEqual({
      ok: true,
      result: {
        sha: FOOBAR_SHA,
        hex: "0x646174613a2c666f6f626172",
        input: "data:,foobar",
      },
    });
  });

  it("hashes a hex encoded data URI to the same digest", async () => {
    const fromUri = await getDigestForData("data:,foobar");
    const fromHex = await getDigestForData("0x646174613a2c666f6f626172");

    expect(fromHex).toEqual(fromUri);
  });

  it("rejects input that is not a data URI", async () => {
    const res = await getDigestForData("foobar");

    expect(res).toMatchObject({ ok: false, error: { code: "BAD_REQUEST", httpStatus: 400 } });
  });
});

describe("estimateDataCost", () => {
  it("prices the calldata with the fetched gas prices", async () => {
    stubFetch(() => gasPrices);

    const res = await estimateDataCost("data:,foobar");

    // 12 non-zero bytes at 16 gas each, plus the 21000 gas transfer.
    const gasNeeded = 12 * 16 + 21_000;
    const wei = gasNeeded * 2 * 1e9;
    expect(calls[0]?.url).toBe("https://www.ethgastracker.com/api/gas/latest");
    expect(res).toMatchObject({
      ok: true,
      result: {
        prices: { block_number: 26_452_452, gas_price: 2, speed: "normal", buffer_fee: 0 },
        cost: { wei, eth: wei / 1e18, usd: (wei / 1e18) * 2000 },
        meta: { gasNeeded, inputLength: 12 },
      },
    });
  });

  it("uses the given speed and buffer", async () => {
    stubFetch(() => gasPrices);

    const res = await estimateDataCost("data:,foobar", { speed: "fast", buffer_fee: 8 });

    expect(res.ok && res.result.meta.gasNeeded).toBe(12 * 16 + 21_000 + 8);
    expect(res.ok && res.result.prices.gas_price).toBe(3);
  });
});

describe("checkExists", () => {
  it("posts the hashes to the given baseURL", async () => {
    stubFetch(() => ({ result: { [`0x${FOOBAR_SHA}`]: TX_HASH } }));

    const res = await checkExists(FOOBAR_SHA, { baseURL: "https://upstream.example" });

    expect(calls[0]?.url).toBe("https://upstream.example/ethscriptions/exists_multi");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ shas: [`0x${FOOBAR_SHA}`] }));
    expect(res).toEqual({ ok: true, result: { [`0x${FOOBAR_SHA}`]: TX_HASH } });
  });

  it("answers 404 when no hash exists", async () => {
    stubFetch(() => ({ result: { [`0x${FOOBAR_SHA}`]: null } }));

    const res = await checkExists(`0x${FOOBAR_SHA}`);

    expect(res).toMatchObject({ ok: false, error: { code: "NOT_FOUND", httpStatus: 404 } });
  });

  it("rejects input without a SHA-256 hash, without a request", async () => {
    stubFetch(() => ({}));

    const res = await checkExists("0x1234");

    expect(res).toMatchObject({ ok: false, error: { code: "NO_VALID_SHA256_HASHES" } });
    expect(calls).toEqual([]);
  });
});

describe("hex and bytes helpers", () => {
  it("turns hex into bytes and back", () => {
    const bytes = hexToBytes("646174613a2c");

    expect([...bytes]).toEqual([0x64, 0x61, 0x74, 0x61, 0x3a, 0x2c]);
    expect(bytesToHex(bytes)).toBe("646174613a2c");
    expect(bytesToHex(new Uint8Array([0x0a, 0x00, 0xff]))).toBe("0a00ff");
  });

  it("checks hex values and addresses", () => {
    expect(isHexValue("646174613a")).toBe(true);
    expect(isHexValue("0x646174613a", true)).toBe(true);
    expect(isHexValue("646174613a", true)).toBe(false);
    expect(isHexValue("xyz")).toBe(false);
    expect(isEthereumAddress("0x34d6bb3280d2f4ef25ff14801e0838dba76ae664")).toBe(true);
    expect(isEthereumAddress("wgw.eth")).toBe(false);
  });
});

describe("getUserProfile", () => {
  it.each([
    ["a list", [upstreamEthscription]],
    ["one object", upstreamEthscription],
  ])("normalizes %s from the upstream", async (_label, result) => {
    stubFetch(() => ({ result }));

    const res = await getUserProfile("0x0000000000000000000000000000000000000001");

    expect(res).toMatchObject({ ok: true, result: { latest: { transaction_hash: TX_HASH } } });
  });
});

const transfer = (block: `${number}`, timestamp: `${number}`): UpstreamTransfer => ({
  transaction_hash: TX_HASH,
  ethscription_transaction_hash: TX_HASH,
  from_address: "0x0000000000000000000000000000000000000001",
  to_address: "0x0000000000000000000000000000000000000002",
  block_number: block,
  block_timestamp: timestamp,
  block_blockhash: "0x01",
  event_log_index: null,
  transaction_index: "1",
  enforced_previous_owner: null,
});

describe("detail modes", () => {
  it("reports the latest transfer time for owner lookups", async () => {
    const ethscription_transfers = [transfer("1", "1000"), transfer("5", "5000")];
    stubFetch(() => ({ result: { ...upstreamEthscription, ethscription_transfers } }));

    const res = await getEthscriptionDetailed(TX_HASH, "owners");

    expect(res).toMatchObject({
      ok: true,
      result: { latest_transfer_datetime: new Date(5_000_000).toISOString() },
    });
  });

  it("answers 404 for an owner lookup without transfers", async () => {
    stubFetch(() => ({ result: upstreamEthscription }));

    const res = await getEthscriptionDetailed(TX_HASH, "owners");

    expect(res).toMatchObject({ ok: false, error: { httpStatus: 404 } });
  });

  it("reports the upstream log index in numbers mode", async () => {
    stubFetch(() => ({ result: { ...upstreamEthscription, event_log_index: "7" } }));

    const res = await getEthscriptionDetailed(TX_HASH, "numbers");

    expect(res).toMatchObject({ ok: true, result: { event_log_index: "7" } });
  });

  it("keeps a computed false field asked for with `with`", async () => {
    stubFetch(() => ({ result: upstreamEthscription }));

    const res = await getEthscriptionById(TX_HASH, { only: "transaction_hash", with: "is_esip8" });

    expect(res.ok && res.result).toEqual({ transaction_hash: TX_HASH, is_esip8: false });
  });
});

describe("transfer order", () => {
  it("orders transfers in one block by transaction and log index", () => {
    const sorted = normalizeAndSortTransfers([
      { ...transfer("5", "5000"), transaction_index: "9", event_log_index: "2" },
      { ...transfer("5", "5000"), transaction_index: "3", event_log_index: null },
      { ...transfer("5", "5000"), transaction_index: "9", event_log_index: "1" },
    ]);

    expect(sorted.map((x) => [x.transaction_index, x.event_log_index, x.transfer_index])).toEqual([
      ["9", "2", 2],
      ["9", "1", 1],
      ["3", null, 0],
    ]);
  });
});

describe("exists check input", () => {
  it("rejects a hex run longer than a hash, without a request", async () => {
    stubFetch(() => ({}));

    const res = await checkExists(`0x${FOOBAR_SHA}a`);

    expect(res).toMatchObject({ ok: false, error: { code: "NO_VALID_SHA256_HASHES" } });
    expect(calls).toEqual([]);
  });

  it("accepts several hashes in one value", async () => {
    stubFetch(() => ({ result: { [`0x${FOOBAR_SHA}`]: TX_HASH } }));

    await checkExists(`0x${FOOBAR_SHA},${"a".repeat(64)}`);

    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ shas: [`0x${FOOBAR_SHA}`, `0x${"a".repeat(64)}`] }),
    );
  });
});

describe("estimateDataCost fees", () => {
  it("prices with the given fees when no gas price is given", async () => {
    stubFetch(() => gasPrices);

    const res = await estimateDataCost("data:,foobar", { base_fee: 3, priority_fee: 1 });

    const gasNeeded = 12 * 16 + 21_000;
    expect(res).toMatchObject({ ok: true, result: { cost: { wei: gasNeeded * 4 } } });
  });
});

describe("exists check upstream errors", () => {
  it("passes the upstream status instead of answering not found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "rate limited" }, { status: 429 })),
    );

    const res = await checkExists(FOOBAR_SHA);

    expect(res).toMatchObject({ ok: false, error: { code: "UPSTREAM_ERROR", httpStatus: 429 } });
  });
});

describe("follow-up fixes", () => {
  it("marks the first transfer in chain order as ESIP-0", () => {
    const sorted = normalizeAndSortTransfers([transfer("5", "5000"), transfer("1", "1000")]);

    expect(sorted.map((x) => [x.block_number, x.is_esip0])).toEqual([
      ["5", false],
      ["1", true],
    ]);
  });

  it("uses the ENS name when the record has no primary name", async () => {
    const res = await namesResolver(
      "0x0000000000000000000000000000000000000001",
      async () => ({ address: "0x0000000000000000000000000000000000000001", ens: "WGW.eth" }),
      { resolveName: true, primary: true },
    );

    expect(res).toBe("wgw.eth");
  });

  it("builds numbers mode even when `only` drops the block fields", async () => {
    stubFetch(() => ({ result: upstreamEthscription }));

    const res = await getEthscriptionDetailed(TX_HASH, "numbers", { only: "transaction_hash" });

    expect(res).toMatchObject({ ok: true, result: { block_number: 26_452_429 } });
  });
});

describe("transaction_hash_only flag", () => {
  it("normalizes the record when the query sends transaction_hash_only=false", async () => {
    stubFetch(() => ({ result: upstreamEthscription }));

    const res = await getEthscriptionById(TX_HASH, { transaction_hash_only: "false" });

    expect(res).toMatchObject({ ok: true, result: { block_number: 26_452_429 } });
  });
});

describe("searchParamsToOptions", () => {
  it("merges repeated keys into a list", () => {
    const params = new URLSearchParams("creator=a&creator=b&media_type=image");

    expect(searchParamsToOptions(params)).toEqual({ creator: ["a", "b"], media_type: "image" });
  });
});
