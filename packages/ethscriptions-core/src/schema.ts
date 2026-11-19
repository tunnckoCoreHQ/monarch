import { z } from "zod";

import { BASE_API_URL, ENUM_ALL_DETAILED, ETH_TYPE, MEDIA_TYPES } from "./const";

export const BooleanSchema = z.stringbool().or(z.boolean());

export const NumberSchema = z.string().transform(Number).pipe(z.number().gte(0));

// Helper for address-like strings (0x... or ENS)
export const AddressSchema = z.string().regex(/^(0x[\dA-Fa-f]{40}|.*\.eth)$/);

export const BaseQuerySchema = z.object({
  baseURL: z.url().default(BASE_API_URL),
  cacheTtl: NumberSchema.default(3600),
  with: z.string().optional(),
  only: z.string().optional(),
  resolve: BooleanSchema.optional(),
  reverse: BooleanSchema.optional(),
  expand: BooleanSchema.optional(),
});

export const HexSchema = z.custom<string>(
  (x) =>
    x &&
    typeof x === "string" &&
    x.length > 0 &&
    /^[\da-f]+$/i.test(x.replace("0x", "")) &&
    x.length % 2 === 0,
  { message: "Expected a valid hex string" },
);

export const TxHashSchema = HexSchema.and(z.string().length(66));

export const NotHexSchema = z.custom(
  (x) => x && typeof x === "string" && x.length > 0 && !/^[\da-f]+$/i.test(x.replace("0x", "")),
  { message: "Expected a not-hex string, received hex" },
);

export const ShaSchema = HexSchema.and(z.string().min(64).max(66));

export const MediaTypeSchema = z.enum(MEDIA_TYPES);

export const ContentTypeSchema = z.string().regex(/^.+\/.+$/, {
  message: 'Invalid Content Type format, must be like "image/png"',
});

export const EthscriptionBaseSchema = z.object({
  transaction_hash: TxHashSchema,
  transaction_index: NumberSchema,
  transaction_value: NumberSchema,
  transaction_fee: NumberSchema,

  block_number: NumberSchema,
  block_blockhash: TxHashSchema,
  block_timestamp: NumberSchema,
  block_datetime: z.iso.datetime(),

  gas_price: NumberSchema,
  gas_used: NumberSchema,
  creator: AddressSchema,
  receiver: AddressSchema,
  media_type: MediaTypeSchema,
  media_subtype: z.string(),
  content_type: ContentTypeSchema,
  content_sha: ShaSchema,
  content_path: z.string().regex(/^\/ethscriptions\/.+\/content$/),
  owners_path: z.string().regex(/^\/ethscriptions\/.+\/owners$/),
  numbers_path: z.string().regex(/^\/ethscriptions\/.+\/numbers$/),
  transfers_path: z.string().regex(/^\/ethscriptions\/.+\/transfers$/),
  is_esip0: z.boolean(),
  is_esip3: z.boolean(),
  is_esip4: z.boolean(),
  is_esip6: z.boolean(),
  is_esip8: z.boolean(),
});

export const EthscriptionTransferSchema = z.object({
  transaction_hash: TxHashSchema,
  from_address: AddressSchema,
  to_address: AddressSchema,

  block_number: z.string().regex(/^\d+$/),
  block_timestamp: z.string().regex(/^\d+$/),
  block_blockhash: TxHashSchema,
  event_log_index: z.string().regex(/^\d+$/).nullable(),
  transaction_index: z.string().regex(/^\d+$/),
  enforced_previous_owner: AddressSchema.or(z.any()).nullable(),

  is_esip0: z.boolean(),
  is_esip1: z.boolean(),
  is_esip2: z.boolean(),
});

export const DataURISchema = z
  .string()
  .min(6)
  .startsWith("data:")
  .or(HexSchema.and(z.string().startsWith("0x646174613a")));

export const UserSchema = HexSchema.and(z.string().length(42)).or(z.string().min(1));

export const IdSchema = z
  .string()
  .transform((x) => x.replaceAll(",", ""))
  .pipe(
    z
      .string()
      .min(1)
      .max(66)
      .regex(/^([1-9]\d*|0x[\dA-Fa-f]{64})$/, {
        message: `Invalid "id" format. Must be a ethscription number or transaction hash`,
      }),
  );

export const DetailedModeSchema = z.enum(ENUM_ALL_DETAILED);
export const EthTypeSchema = z.enum(ETH_TYPE);

export const PaginationSchema = z.object({
  has_more: z.boolean(),
  page_key: TxHashSchema,
  page_size: z.number().int().min(1).max(100).optional(),
});

export const ErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z
    .object({
      code: z.string().optional(),
      message: z.string(),
      httpStatus: z.number().optional(),
      cause: z.any().optional(),
    })
    .or(z.record(z.string(), z.any())),
});
