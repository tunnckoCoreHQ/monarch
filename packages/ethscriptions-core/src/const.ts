export const BASE_API_URL = "https://api.ethscriptions.com/v2";
export const CACHE_TTL = 3600;
export const MEDIA_TYPES = ["image", "text", "video", "audio", "application"] as const;

export const ENUM_METADATA = ["meta", "metadata"] as const;
export const ENUM_CONTENT = ["data", "content"] as const;
export const ENUM_OWNER = [
  "owner",
  "owners",
  "initial",
  "previous",
  "creator",
  "receiver",
] as const;
export const ENUM_SPEEDS = ["slow", "normal", "fast"] as const;
export const ENUM_NUMBERS = ["number", "numbers", "info", "index", "stats"] as const;
export const ENUM_TRANSFER = ["transfer", "transfers"] as const;
export const ENUM_ATTACHMENT = ["attach", "attachment", "blob"] as const;
export const ENUM_ALL_DETAILED = [
  ...ENUM_METADATA,
  ...ENUM_CONTENT,
  ...ENUM_OWNER,
  ...ENUM_NUMBERS,
  ...ENUM_TRANSFER,
  ...ENUM_ATTACHMENT,
] as const;

export const ETH_TYPE = ["ethscriptions", "eths", "blobscriptions", "blobs"] as const;
