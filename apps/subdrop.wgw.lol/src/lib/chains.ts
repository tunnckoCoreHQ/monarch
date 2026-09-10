import { createPublicClient, http, zeroAddress, type Address, type Chain } from "viem";
import { mainnet, sepolia } from "viem/chains";

export interface ChainConfig {
  chain: Chain;
  rpcUrl: string;
  subdrop: Address;
  nameWrapper: Address;
  ensApp: string;
  explorer: string;
}

// Subdrop addresses are zero until the contract is deployed on that chain.
export const chainConfigs: Record<number, ChainConfig> = {
  [mainnet.id]: {
    chain: mainnet,
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    subdrop: zeroAddress,
    nameWrapper: "0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401",
    ensApp: "https://app.ens.domains",
    explorer: "https://etherscan.io",
  },
  [sepolia.id]: {
    chain: sepolia,
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    subdrop: zeroAddress,
    nameWrapper: "0x0635513f179D50A207757E05759CbD106d7dFcE8",
    ensApp: "https://sepolia.app.ens.domains",
    explorer: "https://sepolia.etherscan.io",
  },
};

export const defaultChainId = mainnet.id;

export function chainConfigFor(chainId: number | null): ChainConfig {
  return chainConfigs[chainId ?? defaultChainId] ?? chainConfigs[defaultChainId];
}

export function isSupportedChain(chainId: number | null): boolean {
  return chainId !== null && chainId in chainConfigs;
}

export function isDeployed(config: ChainConfig): boolean {
  return config.subdrop !== zeroAddress;
}

export function publicClientFor(config: ChainConfig) {
  return createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });
}
