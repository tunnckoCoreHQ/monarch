// SPDX-License-Identifier: MPL-2.0

import { fileTypeFromBuffer } from "file-type";

import { BASE_API_URL, CACHE_TTL } from "./const";
import type {
  CheckExistResult,
  DigestResult,
  DigestResultWithCheck,
  EnumAllDetailed,
  EnumSpeeds,
  EstimateCostOptions,
  EstimateCostResult,
  EthscriptionBase,
  FetchOptions,
  ErrorResult,
  OkResult,
  PricesResult,
  ResolveUserResult,
  Result,
  ResultDetailed,
  UpstreamEthscription,
  UserProfileResult,
} from "./types";
import {
  bytesToHex,
  createDigest,
  getHeaders,
  hexToBytes,
  isEthereumAddress,
  isHexValue,
  namesResolver,
  normalizeAndSortTransfers,
  normalizeResult,
  numberFormat,
  upstreamFetcher,
} from "./utils";

type GasOracle = { gwei: number; gasFee: number; priorityFee: number };

type GasTrackerResponse = {
  data: {
    blockNr: `${number}`;
    baseFee: number;
    nextFee: number;
    ethPrice: number;
    oracle: Record<EnumSpeeds, GasOracle>;
  };
};

export async function getPrices(
  speed: EnumSpeeds = "normal",
): Promise<OkResult<PricesResult> | ErrorResult> {
  try {
    const resp = await fetch("https://www.ethgastracker.com/api/gas/latest");

    if (!resp.ok) {
      return {
        ok: false,
        error: {
          message: `Failed to fetch gas prices: ${resp.statusText}`,
          httpStatus: resp.status || 500,
        },
      };
    }

    // SAFETY: the ethgastracker.com API answers with this shape.
    const { data }: GasTrackerResponse = await resp.json();

    return {
      ok: true,
      result: {
        block_number: data.blockNr,
        base_fee: data.baseFee,
        next_fee: data.nextFee,
        eth_price: data.ethPrice,
        gas_price: data.oracle[speed].gwei,
        gas_fee: data.oracle[speed].gasFee,
        priority_fee: data.oracle[speed].priorityFee,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        message: `Failed to fetch prices API: ${String(error)}`,
        httpStatus: 500,
      },
    };
  }
}

export const checkExists = multiCheckExists;

export async function multiCheckExists(
  shas: string | string[],
  options?: FetchOptions,
): Promise<Result<CheckExistResult>> {
  const opts = { baseURL: BASE_API_URL, ...options };
  // A value can hold several hashes with separators. Each hash must be exactly 64 hex digits,
  // with an optional 0x, so a longer run of hex is rejected instead of cut.
  const shaList = (typeof shas === "string" ? [shas] : shas)
    .flatMap((x) => x.split(/[^\da-fx]+/i))
    .map((x) => x.replace(/^0x/i, ""))
    .filter((x) => /^[\da-f]{64}$/i.test(x));

  if (shaList.length === 0) {
    return {
      ok: false,
      error: {
        code: "NO_VALID_SHA256_HASHES",
        message: "No valid SHA-256 hashes provided",
      },
    };
  }

  if (shaList.length > 100) {
    return {
      ok: false,
      error: {
        code: "TOO_MANY_HASHES",
        message: "Too many hashes provided",
      },
    };
  }

  let found: Record<string, string | null>;
  try {
    const resp = await fetch(`${opts.baseURL}/ethscriptions/exists_multi`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ shas: shaList.map((x) => `0x${x}`) }),
    });
    if (!resp.ok) {
      return {
        ok: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to fetch from upstream API",
          httpStatus: resp.status || 500,
        },
      };
    }

    // SAFETY: the upstream exists_multi endpoint maps each hash to a transaction hash or null.
    const body: { result?: Record<string, string | null> } = await resp.json();
    found = body.result || {};
  } catch {
    return {
      ok: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch from upstream API",
        httpStatus: 500,
      },
    };
  }

  const hasFound = Object.values(found).some(Boolean);

  if (!hasFound) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "No ethscriptions found",
        httpStatus: 404,
      },
    };
  }

  if (opts.expand) {
    const expanded = await Promise.all(
      Object.entries(found).map(async ([sha, id]) => {
        if (!id) {
          return [sha, null];
        }

        const detailed = await getEthscriptionDetailed(id, "meta", opts);
        return [sha, detailed.ok ? detailed.result : id];
      }),
    );

    return {
      ok: true,
      result: Object.fromEntries(expanded),
    };
  }

  return {
    ok: true,
    result: found,
  };
}

export async function resolveUser(
  val: string,
  options?: FetchOptions & { checkCreator?: boolean },
): Promise<Result<ResolveUserResult>> {
  const opts = { checkCreator: false, ...options };
  const resolveName = isEthereumAddress(val);

  let resolved: string | null;

  try {
    resolved = await namesResolver(val, null, {
      ...opts,
      resolveName,
      checkCreator: opts.checkCreator,
    });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "RESOLVER_ERROR",
        message: `Error resolving user: ${(error instanceof Error && error.message) || "Unknown error"}`,
        httpStatus: 500,
      },
    };
  }

  if (!resolved) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Cannot resolve ${val}`,
        httpStatus: 404,
      },
    };
  }

  // SAFETY: `val` is an address when `resolveName` is set, and namesResolver returns an address
  // when it is not.
  const address = (resolveName ? val : resolved) as `0x${string}`;
  const result: ResolveUserResult = resolveName
    ? { name: resolved, address }
    : { name: val, address };

  return {
    ok: true,
    result,
    headers: opts.headers || getHeaders(opts.cacheTtl ?? 3600),
  };
}

export async function getUserProfile(
  val: string,
  options?: FetchOptions & { latest?: boolean },
): Promise<Result<UserProfileResult | UserProfileResult["latest"]>> {
  const opts = { ...options };
  const res = await upstreamFetcher({
    ...opts,
    resolve: opts.resolve ?? !isEthereumAddress(val),
    creator: val,
    media_type: "application",
    media_subtype: "vnd.esc.user.profile+json",
  });

  if (!res.ok) {
    return res;
  }

  // The upstream answers with a list, or with one object for a single match.
  const rows = Array.isArray(res.result) ? res.result : [res.result];
  if (rows.length === 0) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `User profile not set up: ${val}`,
        httpStatus: 404,
      },
    };
  }

  const data = rows.map((x) => normalizeResult(x, { ...opts, with: opts.with || "content_uri" }));

  return {
    ok: true,
    result: opts.latest
      ? data[0]
      : {
          latest: data[0],
          previous: data.slice(1),
        },
    headers: opts.headers || getHeaders(opts.cacheTtl ?? 300),
  };
}

export async function getDigestForData(
  input: string | Uint8Array,
  options?: FetchOptions & { checkExists?: unknown },
): Promise<Result<DigestResult | DigestResultWithCheck>> {
  const opts = { ...options };
  const isUint8 = input instanceof Uint8Array;
  const isRawData = isUint8 ? false : input?.startsWith("data:");
  const isHexData = isUint8
    ? false
    : isHexValue(input?.replace(/^0x/, "")) && input?.replace(/^0x/, "")?.startsWith("646174613a");

  const isValid = [isUint8, isRawData, isHexData].includes(true);

  if (!isValid) {
    return {
      ok: false,
      error: {
        code: "BAD_REQUEST",
        message:
          "Invalid data, must be a data URI, as Uint8Array encoded data URI, or hex encoded dataURI string",
        httpStatus: 400,
      },
    };
  }

  try {
    const data = isUint8
      ? input
      : isRawData
        ? new TextEncoder().encode(input)
        : hexToBytes(input.replace(/^0x/, ""));

    const sha = await createDigest(data);
    const hexed = bytesToHex(data);
    const inputData = new TextDecoder("utf-8").decode(data);

    if (opts.checkExists) {
      const resp = await multiCheckExists(sha, opts);

      if (!resp.ok) {
        return resp;
      }

      return {
        ok: true,
        result: {
          sha,
          hex: `0x${hexed}`,
          input: inputData,
          exists: resp.result,
        },
        headers: opts.headers || getHeaders(opts.cacheTtl ?? 300),
      };
    }

    return {
      ok: true,
      result: { sha, hex: `0x${hexed}`, input: inputData },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        message: `Failure in SHA generation: ${String(error)}`,
        httpStatus: 400,
      },
    };
  }
}

export async function getUserCreatedEthscritions(
  val: string,
  options?: FetchOptions,
): Promise<Result<EthscriptionBase[]>> {
  const createdByUser = await getAllEthscriptions({
    ...options,
    resolve: options?.resolve ?? !isEthereumAddress(val),
    creator: val,
  });

  return createdByUser;
}

export async function getUserOwnedEthscriptions(
  val: string,
  options?: FetchOptions,
): Promise<Result<EthscriptionBase[]>> {
  const opts = { ...options };
  const ownedByUser = await getAllEthscriptions({
    ...opts,
    resolve: opts.resolve ?? !isEthereumAddress(val),
    current_owner: val,
    fromOwned: true,
  });

  return ownedByUser;
}

// optionally pass filters/params like `creator=wgw` or `initial_owner=0xAddress`, or `media_subtype=image`,
// but in object notation instead of query string
export async function getAllEthscriptions(
  options: FetchOptions,
): Promise<Result<EthscriptionBase[]>> {
  const opts = { ...options };
  const data = await upstreamFetcher<UpstreamEthscription[]>(opts);

  if (!data.ok) {
    return data;
  }

  if (data.result.length === 0) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: opts.fromOwned
          ? `Profile not set up: ${String(opts.current_owner)}`
          : "No profile results found",
        httpStatus: 404,
      },
    };
  }

  return {
    ok: true,
    result: data.result.map((x) => normalizeResult(x, opts)),
    pagination: data.pagination,
    headers: opts.headers || getHeaders(opts.cacheTtl ?? 15),
  };
}

// optionally pass `with` and `only` filters/params like `with=content_uri` or `only=content_uri,creator,transaction_hash`
export async function getEthscriptionById(
  id: string,
  options?: FetchOptions,
): Promise<Result<EthscriptionBase>> {
  return getEthscriptionDetailed(id, "meta", options);
}

// NOTE: careful changing result fields here, because of the `as ResultDetailed<T>` assertions
// we can footgun ourselves but it's required to be able to have editor complitions!
export async function getEthscriptionDetailed<T extends EnumAllDetailed>(
  id: string,
  type: T,
  options?: FetchOptions,
): Promise<ResultDetailed<T>> {
  if (!type) {
    return {
      ok: false,
      error: { message: "The `type` argument is required ", httpStatus: 500 },
    };
  }

  const opts = { ...options };
  const data = await upstreamFetcher<UpstreamEthscription>(opts, id);

  if (!data.ok) {
    return data;
  }

  const result = normalizeResult(data.result, opts);

  if (type.includes("meta")) {
    // SAFETY: the "meta" and "metadata" modes map to EthscriptionBase.
    return {
      ok: true,
      result,
      headers: opts.headers || getHeaders(CACHE_TTL),
    } as ResultDetailed<T>;
  }

  // NOTE: keep in mind that it can resolve to empty if there's attachment/blob (ESIP-8) instead,
  // because in most cases when ESIP-8 Blobscription is created the regular Ethscription is `data:;esip6` as "content_uri"
  if (/content|data/i.test(type)) {
    // use `data.result` instead of `result` because `content_uri` is not included in `result` by default
    let contentBuffer: ArrayBuffer;
    try {
      contentBuffer = await fetch(data.result.content_uri).then((res) => res.arrayBuffer());
    } catch (error) {
      return {
        ok: false,
        error: { message: `Failed to read the content: ${String(error)}`, httpStatus: 502 },
      };
    }

    const mime = (await fileTypeFromBuffer(contentBuffer))?.mime ?? "";

    const contentHeaders: Record<string, string> = {
      "content-type": result.content_type,
      ...(mime.includes("gzip") ? { "content-encoding": "gzip" } : {}),
    };

    // SAFETY: the "content" and "data" modes map to Uint8Array.
    return {
      ok: true,
      result: new Uint8Array(contentBuffer),
      headers: opts.headers
        ? { ...opts.headers, ...contentHeaders }
        : getHeaders(CACHE_TTL, contentHeaders),
    } as ResultDetailed<T>;
  }

  if (/owner|creator|receiver|previous|initial/i.test(type)) {
    // use `data.result` because transfers does not exists in `result` by default
    // Sorted newest first, so the first transfer is the latest one.
    const [latest] = normalizeAndSortTransfers(data.result.ethscription_transfers);
    if (!latest) {
      return {
        ok: false,
        error: { message: "No transfers found for this ethscription", httpStatus: 404 },
      };
    }

    // SAFETY: the owner modes map to OwnersResult.
    return {
      ok: true,
      result: {
        latest_transfer_timestamp: latest.block_timestamp,
        latest_transfer_datetime: new Date(Number(latest.block_timestamp) * 1000).toISOString(),
        latest_transfer_block: latest.block_number,
        creator: data.result.creator,
        initial: data.result.initial_owner,
        current: data.result.current_owner,
        previous: data.result.previous_owner,
      },

      // transfers theoretically can occure only after 1-5 blocks (60 seconds, so 45s is fine)
      headers: opts.headers || getHeaders(45),
    } as ResultDetailed<T>;
  }

  if (/number|index|stat|info/i.test(type)) {
    // Read the upstream record, because `only` and `with` may leave fields out of `result`.
    const raw = data.result;
    // SAFETY: the number modes map to NumbersResult.
    return {
      ok: true,
      result: {
        block_timestamp: Number(raw.block_timestamp),
        block_datetime: new Date(Number(raw.block_timestamp) * 1000).toISOString(),
        block_blockhash: raw.block_blockhash,
        block_number: Number(raw.block_number),
        block_number_fmt: numberFormat(raw.block_number),
        transaction_index: Number(raw.transaction_index),
        event_log_index: raw.event_log_index,
        ethscription_number: data.result.ethscription_number ?? null,
        ethscription_number_fmt: data.result.ethscription_number
          ? numberFormat(data.result.ethscription_number)
          : "",
        transfers_count: String(
          normalizeAndSortTransfers(data.result.ethscription_transfers).filter((x) => !x.is_esip0)
            .length,
        ),
      },
      headers: opts.headers || getHeaders(60),
    } as ResultDetailed<T>;
  }

  if (/transfer/i.test(type)) {
    // SAFETY: the transfer modes map to EthscriptionTransfer[].
    return {
      ok: true,
      result: normalizeAndSortTransfers(data.result.ethscription_transfers),
      pagination: data.pagination,
      // transfers theoretically can occure only after 5 blocks (60 seconds, so 45s is fine)
      headers: opts.headers || getHeaders(45),
    } as ResultDetailed<T>;
  }

  // NOTE: there's `blob(s)` alternativee because  `/attachment` may be buggy on some hosting providers,
  // noticed that when hosted on Netlify it doesn't like endpoints ending with `/attachment`
  if (/attach|attachment|blob/i.test(type)) {
    if (!data.result.attachment_sha) {
      return {
        ok: false,
        error: {
          message:
            "No attachment for this ethscription, it is not an ESIP-8 compatible Blobscription",
          httpStatus: 404,
        },
      };
    }

    // fetch the attachment content directly from upstream
    const res = await upstreamFetcher<Uint8Array>(opts, `${id}/attachment`);

    if (!res.ok) {
      return res;
    }

    // A missing content type stays out, so the header is never the string "null".
    const attachmentType = data.result.attachment_content_type;
    const attachmentHeaders: Record<string, string> = attachmentType
      ? { "content-type": attachmentType }
      : {};

    // SAFETY: the attachment modes map to Uint8Array.
    return {
      ok: true,
      result: res.result,
      headers: opts.headers
        ? { ...opts.headers, ...attachmentHeaders }
        : getHeaders(CACHE_TTL, attachmentHeaders),
    } as ResultDetailed<T>;
  }

  return {
    ok: false,
    error: { message: "Invalid request", httpStatus: 400 },
  };
}

export async function estimateDataCost(
  input: string | Uint8Array,
  options?: EstimateCostOptions,
): Promise<Result<EstimateCostResult>> {
  const cfg = {
    speed: "normal" as const,
    buffer_fee: 0,
    ...options,
  };
  const prices = await getPrices(cfg.speed);

  if (!prices.ok) {
    return prices;
  }

  const opts = { ...prices.result, ...cfg };

  const isUint8 = input instanceof Uint8Array;
  const isDataUri = isUint8 ? false : input?.startsWith("data:");
  const isHexData = isUint8
    ? false
    : isHexValue(input?.replace(/^0x/, "")) && input?.replace(/^0x/, "")?.startsWith("646174613a");

  const isValid = [isUint8, isDataUri, isHexData].includes(true);

  if (!isValid) {
    return {
      ok: false,
      error: {
        message:
          "Invalid data, must be a data URI as Uint8Array encoded data URI, or hex encoded dataURI string",
        httpStatus: 400,
      },
    };
  }

  try {
    const data = isUint8
      ? input
      : isDataUri
        ? new TextEncoder().encode(input)
        : hexToBytes(input.replace(/^0x/, ""));

    const dataWei = data.reduce((acc, byte) => acc + (byte === 0 ? 4 : 16), 0);
    const transferWei = 21_000;
    const bufferWei = opts.buffer_fee || 0;
    const usedWei = dataWei + transferWei + bufferWei;
    // Given fees without a gas price replace the fetched gas price.
    const useFees =
      options?.gas_price === undefined &&
      (options?.base_fee !== undefined || options?.priority_fee !== undefined);
    const totalGasWei =
      opts.gas_price && !useFees ? opts.gas_price * 1e9 : opts.base_fee + opts.priority_fee;
    const costWei = usedWei * totalGasWei;

    const eth = costWei / 1e18;
    const usd = eth * Number(opts.eth_price);

    opts.block_number = Number(opts.block_number);

    return {
      ok: true,
      result: {
        prices: opts,
        cost: { wei: costWei, eth, usd },
        meta: { gasNeeded: usedWei, inputLength: input.length },
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        message: `Failure in estimate: ${String(error)}`,
        httpStatus: 500,
      },
    };
  }
}

export * from "./const";
export type * from "./types";
export * from "./utils";
