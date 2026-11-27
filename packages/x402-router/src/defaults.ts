export const CDP_FORWARD_TOKEN_HEADER = "X-Forwarded-CDP-Token";
export const PAYAI_FORWARD_TOKEN_HEADER = "X-Forwarded-PayAI-Token";
export const ROUTER_PREFERENCE_HEADER = "X-X402-Router-Preference";

export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
export const PRIMEV_FACILITATOR_URL = "https://facilitator.primev.xyz";
export const X402_ORG_FACILITATOR_URL = "https://x402.org/facilitator";
export const PAYAI_FACILITATOR_URL = "https://facilitator.payai.network";
export const DEXTER_FACILITATOR_URL = "https://x402.dexter.cash";
export const SLUZEN_FACILITATOR_URL = "https://api.sluzen.network/facilitator";

export const ETHEREUM_MAINNET = "eip155:1";
export const BASE_MAINNET = "eip155:8453";
export const BASE_SEPOLIA = "eip155:84532";
export const POLYGON_MAINNET = "eip155:137";
export const ARBITRUM_ONE = "eip155:42161";
export const WORLD_CHAIN = "eip155:480";
export const WORLD_CHAIN_SEPOLIA = "eip155:4801";
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const XRPL_MAINNET = "xrpl:0";

/** The x402 schemes that work through `/verify` and `/settle` alone. */
export const STANDARD_SCHEMES = ["exact", "upto", "batch-settlement"];

export type X402SupportedKind = {
  extra?: Record<string, unknown>;
  network: string;
  scheme: string;
  x402Version: number;
};

export type X402SupportedResponse = {
  extensions?: string[];
  kinds: X402SupportedKind[];
  signers?: Record<string, string[]>;
};

/**
 * How the router authenticates to an upstream. A `forwarded-bearer` upstream gets the token
 * from a request header. When `required` is false, the upstream also works without a token.
 */
export type X402RouterAuth =
  | { type: "none" }
  | { header?: string; required?: boolean; type: "forwarded-bearer" };

export type X402RouterUpstream = {
  auth?: X402RouterAuth;
  facilitatorUrl: string;
  name: string;
  /** Used when the live `/supported` call fails. */
  supportedKinds?: X402SupportedKind[];
};

const exact = (...networks: string[]): X402SupportedKind[] =>
  networks.map((network) => ({ network, scheme: "exact", x402Version: 2 }));

/** The default order. A request's keys and the seller's preference change it per network. */
export const defaultX402RouterUpstreams: X402RouterUpstream[] = [
  {
    facilitatorUrl: PRIMEV_FACILITATOR_URL,
    name: "primev",
    supportedKinds: exact(ETHEREUM_MAINNET),
  },
  {
    auth: { type: "forwarded-bearer" },
    facilitatorUrl: CDP_FACILITATOR_URL,
    name: "cdp",
    supportedKinds: exact(
      BASE_MAINNET,
      POLYGON_MAINNET,
      ARBITRUM_ONE,
      WORLD_CHAIN,
      WORLD_CHAIN_SEPOLIA,
      SOLANA_MAINNET,
    ),
  },
  {
    auth: { header: PAYAI_FORWARD_TOKEN_HEADER, required: false, type: "forwarded-bearer" },
    facilitatorUrl: PAYAI_FACILITATOR_URL,
    name: "payai",
    supportedKinds: exact(
      BASE_MAINNET,
      BASE_SEPOLIA,
      POLYGON_MAINNET,
      "eip155:80002",
      ARBITRUM_ONE,
      "eip155:421614",
      "eip155:56",
      "eip155:97",
      "eip155:43114",
      "eip155:43113",
      "eip155:1329",
      "eip155:713715",
      "eip155:196",
      "eip155:1952",
      "eip155:1187947933",
      "eip155:324705682",
      SOLANA_MAINNET,
      SOLANA_DEVNET,
    ),
  },
  {
    facilitatorUrl: DEXTER_FACILITATOR_URL,
    name: "dexter",
    supportedKinds: exact(
      BASE_MAINNET,
      BASE_SEPOLIA,
      POLYGON_MAINNET,
      ARBITRUM_ONE,
      WORLD_CHAIN,
      "eip155:10",
      "eip155:56",
      "eip155:43114",
      "eip155:143",
      "eip155:4663",
      "eip155:1187947933",
      "eip155:324705682",
      SOLANA_MAINNET,
      SOLANA_DEVNET,
    ),
  },
  {
    facilitatorUrl: SLUZEN_FACILITATOR_URL,
    name: "sluzen",
    supportedKinds: exact(XRPL_MAINNET),
  },
  {
    facilitatorUrl: X402_ORG_FACILITATOR_URL,
    name: "x402",
    supportedKinds: exact(BASE_SEPOLIA, SOLANA_DEVNET),
  },
];
