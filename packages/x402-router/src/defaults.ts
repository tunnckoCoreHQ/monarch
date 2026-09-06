export const CDP_FORWARD_TOKEN_HEADER = "X-Forwarded-CDP-Token";
export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
export const PRIMEV_FACILITATOR_URL = "https://facilitator.primev.xyz";
export const X402_ORG_FACILITATOR_URL = "https://x402.org/facilitator";

export const ETHEREUM_MAINNET = "eip155:1";
export const BASE_MAINNET = "eip155:8453";
export const BASE_SEPOLIA = "eip155:84532";
export const POLYGON_MAINNET = "eip155:137";
export const ARBITRUM_ONE = "eip155:42161";
export const WORLD_CHAIN = "eip155:480";
export const WORLD_CHAIN_SEPOLIA = "eip155:4801";
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

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

export type X402RouterAuth = { type: "none" } | { header?: string; type: "forwarded-bearer" };

export type X402RouterUpstream = {
  auth?: X402RouterAuth;
  facilitatorUrl: string;
  name: string;
  supportedKinds?: X402SupportedKind[];
};

const exact = (network: string): X402SupportedKind => ({
  network,
  scheme: "exact",
  x402Version: 2,
});

export const defaultX402RouterUpstreams: X402RouterUpstream[] = [
  {
    facilitatorUrl: PRIMEV_FACILITATOR_URL,
    name: "primev-mainnet",
    supportedKinds: [exact(ETHEREUM_MAINNET)],
  },
  {
    facilitatorUrl: X402_ORG_FACILITATOR_URL,
    name: "x402-testnet",
    supportedKinds: [exact(BASE_SEPOLIA), exact(SOLANA_DEVNET)],
  },
  {
    auth: { type: "forwarded-bearer" },
    facilitatorUrl: CDP_FACILITATOR_URL,
    name: "cdp-mainnet",
    supportedKinds: [
      exact(BASE_MAINNET),
      exact(POLYGON_MAINNET),
      exact(ARBITRUM_ONE),
      exact(WORLD_CHAIN),
      exact(WORLD_CHAIN_SEPOLIA),
      exact(SOLANA_MAINNET),
    ],
  },
];

export const defaultX402SupportedResponse: X402SupportedResponse = {
  kinds: defaultX402RouterUpstreams.flatMap((upstream) => upstream.supportedKinds ?? []),
};
