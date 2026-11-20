import type {
  ENUM_ALL_DETAILED,
  ENUM_ATTACHMENT,
  ENUM_CONTENT,
  ENUM_METADATA,
  ENUM_NUMBERS,
  ENUM_OWNER,
  ENUM_SPEEDS,
  ENUM_TRANSFER,
  MEDIA_TYPES,
} from "./const";

export type EnumMediaType = (typeof MEDIA_TYPES)[number];
export type EnumSpeeds = (typeof ENUM_SPEEDS)[number];
export type EnumMetadata = (typeof ENUM_METADATA)[number];
export type EnumContent = (typeof ENUM_CONTENT)[number];
export type EnumOwner = (typeof ENUM_OWNER)[number];
export type EnumNumbers = (typeof ENUM_NUMBERS)[number];
export type EnumTransfer = (typeof ENUM_TRANSFER)[number];
export type EnumAttachment = (typeof ENUM_ATTACHMENT)[number];
export type EnumAllDetailed = (typeof ENUM_ALL_DETAILED)[number];

// The options every function takes. Other keys are upstream API filters, like `creator`,
// `media_type`, or `page_key`.
export type FetchOptions = {
  baseURL?: string;
  cacheTtl?: number;
  headers?: Record<string, string>;
  resolve?: boolean;
  expand?: boolean;
  with?: string | string[];
  only?: string | string[];
  cf?: boolean;
  [filter: string]: unknown;
};

// A transfer as the upstream Ethscriptions API returns it.
export type UpstreamTransfer = {
  ethscription_transaction_hash?: `0x${string}`;
  transaction_hash: `0x${string}`;
  from_address: `0x${string}`;
  to_address: `0x${string}`;
  block_number: `${number}`;
  block_timestamp: `${number}`;
  block_blockhash: `0x${string}`;
  event_log_index: `${number}` | null;
  transaction_index: `${number}`;
  enforced_previous_owner: `0x${string}` | null;
};

// An ethscription as the upstream Ethscriptions API returns it.
export type UpstreamEthscription = {
  transaction_hash: `0x${string}`;
  block_number: `${number}`;
  block_blockhash: `0x${string}`;
  block_timestamp: `${number}`;
  transaction_index: `${number}`;
  event_log_index: `${number}` | null;
  // Wei amounts. The API sends them as strings, sometimes with a ".0" suffix; numbers also parse.
  value: string | number;
  transaction_fee: string | number;
  gas_price: string | number;
  gas_used: string;
  creator: `0x${string}`;
  initial_owner: `0x${string}`;
  current_owner: `0x${string}`;
  previous_owner: `0x${string}`;
  media_type: EnumMediaType;
  mime_subtype: string;
  mimetype: `${EnumMediaType}/${string}`;
  content_sha: `0x${string}`;
  content_uri: string;
  esip6: boolean;
  attachment_sha?: `0x${string}` | null;
  attachment_content_type?: string | null;
  ethscription_number?: `${number}` | null;
  ethscription_transfers: UpstreamTransfer[];
  [field: string]: unknown;
};

export type EthscriptionBase = {
  block_number: number;
  block_hash: `0x${string}`;
  block_timestamp: number;
  block_datetime: string;
  event_log_index?: `${number}` | null;
  transaction_hash: `0x${string}`;
  transaction_index: number;
  transaction_value: bigint;
  transaction_fee: bigint;
  gas_price: bigint;
  gas_used: bigint;
  creator: `0x${string}`;
  receiver: `0x${string}`;
  media_type: EnumMediaType;
  media_subtype: string;
  content_type: `${EnumMediaType}/${string}`;
  content_sha: `0x${string}`;
  content_path: `/ethscriptions/${string}/content`;
  owners_path: `/ethscriptions/${string}/owners`;
  numbers_path: `/ethscriptions/${string}/numbers`;
  transfers_path: `/ethscriptions/${string}/transfers`;
  attachment_content_type?: string | null;
  attachment_media_type?: string | null;
  attachment_sha?: `0x${string}` | null;
  attachment_path?: `/ethscriptions/${string}/attachment`;
  is_esip0: boolean;
  is_esip3: boolean;
  is_esip4: boolean | undefined;
  is_esip6: boolean;
  is_esip8: boolean;
};

export type EthscriptionTransfer = {
  transaction_hash: `0x${string}`;
  from_address: `0x${string}`;
  to_address: `0x${string}`;
  block_number: `${number}`;
  block_timestamp: `${number}`;
  block_hash: `0x${string}`;
  event_log_index: `${number}` | null;
  transaction_index: `${number}`;
  transfer_index: number;
  enforced_previous_owner: `0x${string}` | null;
  is_esip0: boolean;
  is_esip1: boolean;
  is_esip2: boolean;
};

// Maps each SHA-256 hash to the transaction hash of its ethscription, or to the ethscription
// itself with `expand`, or to null when it does not exist.
export type CheckExistResult = Record<string, string | EthscriptionBase | null>;

export type ResolveUserResult = {
  name: string;
  address: `0x${string}`;
};

export type UserProfileResult = {
  latest: EthscriptionBase;
  previous: EthscriptionBase[];
};

export type DigestResult = {
  sha: string;
  hex: `0x${string}`;
  input: string;
};

export type DigestResultWithCheck = DigestResult & {
  exists: CheckExistResult;
};

export type OwnersResult = {
  latest_transfer_timestamp: `${number}`;
  latest_transfer_datetime: string;
  latest_transfer_block: `${number}`;
  creator: `0x${string}`;
  initial: `0x${string}`;
  current: `0x${string}`;
  previous: `0x${string}`;
};

export type NumbersResult = {
  block_timestamp: number;
  block_datetime: string;
  block_blockhash: `0x${string}`;
  block_number: number;
  block_number_fmt: string;
  transaction_index: number;
  event_log_index: `${number}` | null;
  ethscription_number: `${number}` | null;
  ethscription_number_fmt: string;
  transfers_count: `${number}`;
};

export type PricesResult = {
  block_number: number | `${number}`;
  base_fee: number;
  next_fee: number;
  eth_price: number | string;
  gas_price: number;
  gas_fee: number;
  priority_fee: number;
};

export type BaseCostOpts = {
  speed: EnumSpeeds;
  usePrices: boolean;
  buffer_fee: number;
};

// Every field is optional: the defaults and the current gas prices fill the rest.
export type EstimateCostOptions = Partial<BaseCostOpts & PricesResult>;

export type EstimateCostResult = {
  prices: PricesResult & BaseCostOpts;
  cost: { wei: number; eth: number; usd: number };
  meta: { gasNeeded: number; inputLength: number };
};

export type EnsRecord = {
  address?: string;
  ens?: string;
  ens_primary?: string;
};

export type EnsHandler = (
  value: string,
  options: NamesResolverOptions,
) => Promise<EnsRecord | null>;

// The viem public client methods that `ensBasicOnchainHandler` uses.
export type EnsPublicClient = {
  getEnsAddress: (args: { name: string }) => Promise<`0x${string}`>;
  getEnsName: (args: { address: string }) => Promise<string>;
};

export type NamesResolverOptions = {
  resolveName?: boolean;
  primary?: boolean;
  checkCreator?: boolean;
  publicClient?: EnsPublicClient;
  baseURL?: string;
};

export type PaginationType = {
  has_more: boolean;
  page_key: `0x${string}`;
  page_size?: number;
};

export type OkResult<T> = {
  ok: true;
  result: T;
  headers?: Headers | Record<string, string>;
  pagination?: PaginationType;
};

export type ErrorResult = {
  ok: false;
  error: {
    code?: string;
    message: string;
    httpStatus?: number;
    cause?: unknown;
  };
};

export type DetailedMap<T extends EnumAllDetailed> = {
  meta: EthscriptionBase;
  metadata: EthscriptionBase;

  data: Uint8Array;
  content: Uint8Array;

  owner: OwnersResult;
  owners: OwnersResult;
  initial: OwnersResult;
  previous: OwnersResult;
  creator: OwnersResult;
  receiver: OwnersResult;

  number: NumbersResult;
  numbers: NumbersResult;
  info: NumbersResult;
  index: NumbersResult;
  stats: NumbersResult;

  transfer: EthscriptionTransfer[];
  transfers: EthscriptionTransfer[];

  attach: Uint8Array;
  attachment: Uint8Array;
  blob: Uint8Array;
}[T];

export type ResultDetailed<T extends EnumAllDetailed> = OkResult<DetailedMap<T>> | ErrorResult;
export type Result<T> = OkResult<T> | ErrorResult;
