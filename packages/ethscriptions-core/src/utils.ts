// SPDX-License-Identifier: MPL-2.0

import { CacheHeaders } from "cdn-cache-control";
import * as qs from "qs-esm";

import { BASE_API_URL } from "./const";
import { HexSchema } from "./schema";
import type {
  EnsHandler,
  EnsPublicClient,
  EnsRecord,
  EthscriptionBase,
  EthscriptionTransfer,
  FetchOptions,
  NamesResolverOptions,
  OkResult,
  PaginationType,
  Result,
  UpstreamEthscription,
  UpstreamTransfer,
} from "./types";

type UpstreamResponse<T> = {
  result: T;
  pagination?: PaginationType;
};

export async function upstreamFetcher<T = UpstreamEthscription | UpstreamEthscription[]>(
  options?: FetchOptions,
  id?: string | null,
): Promise<Result<T>> {
  let opts: Record<string, unknown> = {
    resolve: false,
    baseURL: BASE_API_URL,
    ...filtersNormalizer({ ...options }),
  };

  if (["true", "1"].includes(String(opts.resolve))) {
    let res: Record<string, unknown>;

    try {
      res = await resolveAddressPatches(opts);
    } catch (error) {
      console.error(
        "Error stack (failed to resolve address patches)",
        error instanceof Error ? error.stack : undefined,
      );
      return {
        ok: false,
        error: {
          message: `Failed to resolve address patches: ${String(error)}`,
          httpStatus: 500,
        },
      };
    }

    opts = { ...opts, ...res };
  } else {
    logHints(opts);
  }

  const baseURL = String(opts.baseURL ?? BASE_API_URL);

  delete opts.resolve;
  delete opts.baseURL;
  delete opts.expand;
  delete opts.with;

  const searchStr = qs.stringify(opts, { encode: false, indices: false });

  // for the mime subtype filters (vnd.esc.user.profile+json)
  const searchParams = new URLSearchParams(searchStr.replaceAll("+", "%2B"));

  const isAttachment = id && /attach|blob/i.test(id);
  const fpath = (isAttachment ? [id.split("/")[0], "attachment"] : [id || ""]).join("/");
  const search = Object.entries(opts).length > 0 ? `?${searchParams.toString()}` : "";
  const oneDay = 24 * 60 * 60;
  const defaultCacheOpts = {
    "100-199": 0,
    "200-299": oneDay * 30,
    "300-399": 300,
    "400-499": 10,
    "500-599": 10,
  };

  const cfFetchCacheOptions: RequestInit | undefined = !opts.cf
    ? undefined
    : /.+owner|creator|receiver|previous|initial|transfer$/i.test(fpath)
      ? {
          cf: {
            cacheEverything: true,
            cacheTtlByStatus: defaultCacheOpts,
            cacheTags: ["ethscriptions", ...fpath.split("/")],
          },
        }
      : /.+number|index|stat|info$/i.test(fpath)
        ? {
            cf: {
              cacheEverything: true,
              cacheTtlByStatus: { ...defaultCacheOpts, "200-299": 3600 },
              cacheTags: ["ethscriptions", ...fpath.split("/")],
            },
          }
        : undefined;

  let resp: Response;

  try {
    resp = await fetch(
      `${baseURL}/ethscriptions${id ? `/${fpath}` : ""}${search}`,
      cfFetchCacheOptions,
    );
  } catch (error) {
    return {
      ok: false,
      error: {
        message: `Fetch failed unexpectedly: ${String(error)}`,
        httpStatus: 500,
      },
    };
  }

  if (!resp.ok) {
    console.error("Failed to fetch data from upstream API:", resp.status, resp.statusText);

    return {
      ok: false,
      error: {
        message: "Transaction not found or it is not an Ethscription.",
        httpStatus: resp.status,
      },
    };
  }

  if (isAttachment) {
    // SAFETY: the caller asks for an attachment path only with `T` as Uint8Array.
    return { ok: true, result: new Uint8Array(await resp.arrayBuffer()) as T };
  }

  let data: UpstreamResponse<T>;

  try {
    // SAFETY: the upstream API wraps every JSON response in `result`, with an optional
    // `pagination`, and the caller picks `T` for the path it fetches.
    data = await resp.json();
  } catch (error) {
    return {
      ok: false,
      error: {
        message: `Failed to parse JSON response: ${String(error)}`,
        httpStatus: 500,
      },
    };
  }

  const res: OkResult<T> = { ok: true, result: data.result };

  if (data.pagination) {
    res.pagination = data.pagination;
    return { ...res };
  }

  return res;
}

function isNotAddress(value: unknown): boolean {
  return typeof value === "string" && !value.startsWith("0x") && value.length > 2;
}

function logHints(opts: Record<string, unknown> = {}): void {
  if (isNotAddress(opts.creator)) {
    console.info("Creator is not an address, maybe you want to use `resolve: true`");
  } else if (isNotAddress(opts.owner) || isNotAddress(opts.current_owner)) {
    console.info("Current owner is not an address, maybe you want to use `resolve: true`");
  } else if (
    isNotAddress(opts.initial) ||
    isNotAddress(opts.initial_owner) ||
    isNotAddress(opts.receiver)
  ) {
    console.info(
      "Initial owner (receiver) is not an address, maybe you want to use `resolve: true`",
    );
  }
}

function chainOrder(
  a: Pick<UpstreamTransfer, "block_number" | "transaction_index" | "event_log_index">,
  b: Pick<UpstreamTransfer, "block_number" | "transaction_index" | "event_log_index">,
): number {
  return (
    Number(a.block_number) - Number(b.block_number) ||
    Number(a.transaction_index) - Number(b.transaction_index) ||
    Number(a.event_log_index ?? -1) - Number(b.event_log_index ?? -1)
  );
}

export function normalizeAndSortTransfers(transfers: UpstreamTransfer[]): EthscriptionTransfer[] {
  return (
    transfers
      // oxlint-disable-next-line no-unused-vars -- the rename drops the field from the rest object.
      .map(({ ethscription_transaction_hash: _, block_blockhash, ...x }) => ({
        ...x,
        block_hash: block_blockhash,
        // theoretically, it could be ESIP-1 Transfer too, but ESIP-2 is more used and more likely
        is_esip1: x.event_log_index !== null,
        is_esip2: x.event_log_index !== null,
      }))
      // sort by block number, ascending
      .toSorted(chainOrder)
      .map((x, idx) => ({
        ...x,
        is_esip0: idx === 0,
        transfer_index: idx,
      }))
      // sort by block number, descending after setting the transfer index
      .toSorted((a, b) => chainOrder(b, a))
  );
}

export function normalizeResult(
  result: UpstreamEthscription,
  options?: FetchOptions,
): EthscriptionBase {
  const opts = { ...options };

  const keys = Object.keys(result || {});

  const withs = Array.isArray(opts.with) ? opts.with : opts.with?.split(",") || [];
  const onlys = Array.isArray(opts.only) ? opts.only : opts.only?.split(",") || [];
  const isTxOnly =
    (keys.length === 1 && keys[0] === "transaction_hash") || opts.transaction_hash_only;

  if (isTxOnly) {
    // SAFETY: a transaction-hash-only result passes through as the upstream API returned it.
    return Object.fromEntries(Object.entries(result)) as EthscriptionBase;
  }

  const res = {
    block_number: Number(result.block_number),
    block_hash: result.block_blockhash,
    block_timestamp: Number(result.block_timestamp),
    block_datetime: new Date(Number(result.block_timestamp) * 1000).toISOString(),
    transaction_hash: result.transaction_hash,
    transaction_index: Number(result.transaction_index),
    transaction_value: BigInt(String(result.value).replace(/\.0$/, "")),
    transaction_fee: BigInt(String(result.transaction_fee).replace(/\.0$/, "")),
    gas_price: BigInt(String(result.gas_price).replace(/\.0$/, "")),
    gas_used: BigInt(result.gas_used),
    creator: result.creator,
    receiver: result.initial_owner,
    media_type: result.media_type,
    media_subtype: result.mime_subtype,
    content_type: result.mimetype,
    content_sha: result.content_sha,
    content_path: `/ethscriptions/${result.transaction_hash}/content`,
    owners_path: `/ethscriptions/${result.transaction_hash}/owners`,
    numbers_path: `/ethscriptions/${result.transaction_hash}/numbers`,
    transfers_path: `/ethscriptions/${result.transaction_hash}/transfers`,
    // Note use `with=content_uri`
    ...(result.attachment_sha
      ? {
          attachment_content_type: result.attachment_content_type,
          attachment_media_type: result.attachment_content_type?.split("/").at(0) || null,
          attachment_sha: result.attachment_sha,
          attachment_path: `/ethscriptions/${result.transaction_hash}/attachment`,
        }
      : {}),
    is_esip0: result.event_log_index === null,
    is_esip3: result.event_log_index !== null,
    is_esip4: result.content_uri?.includes("vnd.facet.tx+json"),
    is_esip6: result.esip6,
    is_esip8: Boolean(result.attachment_sha),
  };
  const fields: Record<string, unknown> = res;

  const onlyRes: Record<string, unknown> = Object.fromEntries(
    Object.entries(res).filter(([key]) => {
      if (onlys.length > 0) {
        return onlys.includes(key);
      }
      return true;
    }),
  );

  for (const withKey of withs) {
    if (!(withKey in onlyRes)) {
      onlyRes[withKey] = withKey in fields ? fields[withKey] : result[withKey];
    }
  }

  // SAFETY: without `only` and `with` it holds every field. With them, the caller picks the
  // fields, and gets what it asked for.
  return onlyRes as EthscriptionBase;
}

export function filtersNormalizer(opts: Record<string, unknown>): Record<string, unknown> {
  // consistency, we name mime_subtype as media_subtype, to be consistent with media_type
  if (opts.media_subtype) {
    opts.mime_subtype = opts.media_subtype;
    delete opts.media_subtype;
  }

  if (opts.per_page) {
    opts.max_results = opts.per_page;
  }

  if (opts.page_size) {
    opts.max_results = opts.page_size;
  }

  if (opts.cursor) {
    opts.page_key = opts.cursor;
    delete opts.cursor;
  }

  // patch `receiver` with `initial_owner` for consistency with other fields
  if (opts.receiver) {
    opts.initial_owner = opts.receiver;
    delete opts.receiver;
  }

  // patch `initial` with `initial_owner` for consistency with other fields
  if (opts.initial) {
    opts.initial_owner = opts.initial;
    delete opts.initial;
  }

  // patch `previous` with `previous_owner` for consistency with other fields
  if (opts.previous) {
    opts.previous_owner = opts.previous;
    delete opts.previous;
  }

  // patch `current` with `current_owner` for consistency with other fields
  if (opts.current) {
    opts.current_owner = opts.current;
    delete opts.current;
  }
  if (opts.owner) {
    opts.current_owner = opts.owner;
    delete opts.owner;
  }

  // blocks
  if (opts.min_block_number) {
    opts.after_block = opts.min_block_number;
    delete opts.min_block_number;
  }
  if (opts.max_block_number) {
    opts.before_block = opts.max_block_number;
    delete opts.max_block_number;
  }
  if (opts.block_hash) {
    opts.block_blockhash = opts.block_hash;
    delete opts.block_hash;
  }

  // content_type is equal to `<media_type>/<media_subtype>`, it's called "mimetype" in upstream
  if (opts.content_type) {
    opts.mimetype = opts.content_type;
    delete opts.content_type;
  }
  // if `content_type[]=foo/bar&content_type[]=abc/qux`, eg it's is multiples
  const params = Object.entries(opts);
  if (params.some(([key]) => key.startsWith("content_type"))) {
    const contentTypes = params
      .filter(([key]) => key.startsWith("content_type"))
      .map(([, value]) => value);
    opts.mimetype = contentTypes;
  }

  // support `is_esip6` instead of just `esip6` for consistency with fields and other ESIPs fiekds
  // Note: no such `esip6` filter on upstream, i thought there is. But lets keep it for now
  if (opts.is_esip6) {
    opts.esip6 = opts.is_esip6;
    delete opts.is_esip6;
  }

  return { ...opts };
}

export function filtersNormalizerFromUrlSearchParams(
  searchParams: URLSearchParams,
): URLSearchParams {
  const opts: Record<string, string | string[]> = {};
  for (const [key, value] of searchParams.entries()) {
    const existing = opts[key];

    opts[key] = existing
      ? Array.isArray(existing)
        ? [...existing, value]
        : [existing, value]
      : value;
  }

  const normalizedOptions = filtersNormalizer(opts);
  const searchParamsStr = qs.stringify(normalizedOptions, {
    encode: false,
    indices: false,
  });

  return new URLSearchParams(searchParamsStr);
}

export async function resolveAddressPatches(
  options: Record<string, unknown>,
  ensHandler?: EnsHandler,
): Promise<Record<string, unknown>> {
  const opts = { ...options };

  const addressParams = Object.entries(opts).filter(
    (entry): entry is [string, string] =>
      /creator|receiver|owner/i.test(entry[0]) &&
      typeof entry[1] === "string" &&
      entry[1].length > 0 &&
      !isEthereumAddress(entry[1]),
  );

  const params = await Promise.all(
    addressParams.map(async ([key, value]) => {
      // if it cannot resolve neither ENS, nor Ethscriptions Name, it returns null
      const val = await namesResolver(value, ensHandler, {
        ...options,
        resolveName: false,
      });

      // `val` is null, passthrough the `value`
      return [key, val || value];
    }),
  );

  return { ...opts, ...Object.fromEntries(params) };
}

export async function namesResolver(
  value: string,
  ensHandler?: EnsHandler | null,
  options?: NamesResolverOptions,
): Promise<string | null> {
  const opts = { baseURL: BASE_API_URL, ...options };
  const val = value.toLowerCase();
  const handler = ensHandler || ensApiHandler;

  const result = await handler(val, opts);

  // if ensdata API returns 404, or if there's no `address` and only `ens` then it's some mistake
  if (result && result.address && result.ens) {
    const resolved = opts.resolveName
      ? opts.primary
        ? (result.ens_primary ?? result.ens)
        : result.ens
      : result.address;

    return resolved.toLowerCase();
  }

  // thus if not properly resolved, we fallback to try to find address by Ethscription Name
  // NOTE 1: by default "Ethscription Name" is every ethscription like `data:,[a-z0-9]` (insensitive),
  // but the WGW API expand that definition to that it can be anything (like `59.eths` or `wgw.lol` too) that is not resolvable ENS domain
  //
  // NOTE 2: support reverse resolving, like passing an address and finding the primary Ethscription Name,
  // which could be tricky because one can have multiple. The only way,
  // is if they specifically set "primary" field in their Ethscription User Profile;
  // or just return the first from a list of owned Ethscription Names

  // NOTE 3: on `nameUri`. Should use the raw input and not force lowercase, because both are different things and SHAs.
  // By default the Ethscription Name is case-insensitive (regex /[a-z0-9]/gi), and force lowercase, which may lead to scams, confusion, etc,
  // For example: one can have `Foobie` and another have `foobie`, low-level stuff should be able to differentiate them.
  // Higher-level APIs and tools can enforce the case-insensitivity, if they want to, by lowercasing before passing it to this function.
  const nameUri = `data:,${value}`;

  const nameSha = await createDigest(nameUri);

  const resp = await fetch(`${opts.baseURL}/ethscriptions/exists/0x${nameSha}`);
  // SAFETY: the upstream exists endpoint answers with this shape.
  const body: { result: { exists: boolean; ethscription: UpstreamEthscription } } =
    await resp.json();

  if (body.result.exists) {
    const eth = body.result.ethscription;
    return (opts.checkCreator ? eth.creator : eth.current_owner).toLowerCase();
  }

  return null;
}

export async function ensApiHandler(val: string): Promise<EnsRecord | null> {
  const resp = await fetch(`https://api.ensdata.net/${val}`);

  if (!resp.ok) {
    return null;
  }

  // SAFETY: the ensdata.net API answers with the ENS record of the name or address.
  const data: EnsRecord = await resp.json();

  return data;
}

export async function ensBasicOnchainHandler(
  val: string,
  options: {
    resolveName: boolean;
    publicClient: EnsPublicClient;
    normalize: (name: string) => string;
  },
): Promise<{ ens: string; address: `0x${string}` } | null> {
  const opts = { ...options };

  const address = await opts.publicClient.getEnsAddress({
    name: opts.normalize(val),
  });

  // getEnsAddress never throws, it returns the input if it's not an ENS name
  if (address.toLowerCase() === val.toLowerCase()) {
    return null;
  }

  let ens = val;

  if (opts.resolveName) {
    ens = await opts.publicClient.getEnsName({
      address: val.toLowerCase(),
    });
  }

  return { ens, address };
}

export function getHeaders(
  time = 31_536_000, // 1 year
  additionalHeaders: Record<string, string> = {},
  cfType = "must-revalidate",
): CacheHeaders {
  // adds vary, cache-control, and cdn-cache-control headers
  const headers = new CacheHeaders({
    "Netlify-CDN-Cache-Control": `public,s-maxage=${time},must-revalidate,durable`,
    "Vercel-CDN-Cache-Control": `public,s-maxage=${time},must-revalidate`,
    "Cloudflare-CDN-Cache-Control": `public,s-maxage=${time},${cfType}`,
    ...additionalHeaders,
  }).ttl(time);

  return headers;
}

export async function createDigest(
  msg: string | Uint8Array,
  algo: "SHA-1" | "SHA-256" | "SHA-512" = "SHA-256",
): Promise<string> {
  const data = typeof msg === "string" ? new TextEncoder().encode(msg) : msg;
  // SAFETY: a Uint8Array view is a valid BufferSource for digest; the cast only narrows its
  // generic buffer type, which TypeScript widens to ArrayBufferLike.
  const hashBuffer = await crypto.subtle.digest(algo, data as Uint8Array<ArrayBuffer>);
  const hashArray = [...new Uint8Array(hashBuffer)];
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex;
}

export function numberFormat(x: string | number, delim = ","): string {
  if (!x) {
    return "";
  }

  const str = String(x).split("").toReversed().join("");
  const mm = str.match(/.{1,3}/g);

  if (!mm) {
    return String(x);
  }

  return mm
    .map((z) => z.split("").toReversed().join(""))
    .toReversed()
    .join(delim);
}

export function hexToBytes(str: string): Uint8Array {
  return new Uint8Array([...str.matchAll(/../g)].map((m) => Number.parseInt(m[0], 16)));
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((n) => n.toString(16).padStart(2, "0")).join("");
}

export function isEthereumAddress(val: string): boolean {
  return (
    typeof val === "string" &&
    val.startsWith("0x") &&
    HexSchema.safeParse(val).success &&
    val.length === 42
  );
}

export function isHexValue(val: string, prefixed = false): boolean {
  if (prefixed) {
    return typeof val === "string" && val.startsWith("0x") && HexSchema.safeParse(val).success;
  }

  return HexSchema.safeParse(val).success;
}
