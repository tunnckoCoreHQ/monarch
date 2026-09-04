export const WALLET_PROFILE_IDS = [
  "evm",
  "solana",
  "bitcoin-native-segwit-mainnet",
  "bitcoin-native-segwit-testnet",
  "bitcoin-taproot-mainnet",
  "bitcoin-taproot-testnet",
] as const;

export type WalletProfileId = (typeof WALLET_PROFILE_IDS)[number];

interface BaseWalletProfile {
  id: WalletProfileId;
  label: string;
  path: (accountIndex: number) => string;
}

interface EvmWalletProfile extends BaseWalletProfile {
  chain: "evm";
}

interface SolanaWalletProfile extends BaseWalletProfile {
  chain: "solana";
}

interface BitcoinWalletProfile extends BaseWalletProfile {
  chain: "bitcoin";
  network: "mainnet" | "testnet";
  addressType: "native-segwit" | "taproot";
}

export type WalletProfile = EvmWalletProfile | SolanaWalletProfile | BitcoinWalletProfile;

const profiles: Record<WalletProfileId, WalletProfile> = {
  evm: {
    id: "evm",
    label: "EVM",
    chain: "evm",
    path: (accountIndex) => `m/44'/60'/${accountIndex}'/0/0`,
  },
  solana: {
    id: "solana",
    label: "Solana",
    chain: "solana",
    path: (accountIndex) => `m/44'/501'/${accountIndex}'/0'`,
  },
  "bitcoin-native-segwit-mainnet": {
    id: "bitcoin-native-segwit-mainnet",
    label: "Bitcoin Native SegWit Mainnet",
    chain: "bitcoin",
    network: "mainnet",
    addressType: "native-segwit",
    path: (accountIndex) => `m/84'/0'/${accountIndex}'/0/0`,
  },
  "bitcoin-native-segwit-testnet": {
    id: "bitcoin-native-segwit-testnet",
    label: "Bitcoin Native SegWit Testnet",
    chain: "bitcoin",
    network: "testnet",
    addressType: "native-segwit",
    path: (accountIndex) => `m/84'/1'/${accountIndex}'/0/0`,
  },
  "bitcoin-taproot-mainnet": {
    id: "bitcoin-taproot-mainnet",
    label: "Bitcoin Taproot Mainnet",
    chain: "bitcoin",
    network: "mainnet",
    addressType: "taproot",
    path: (accountIndex) => `m/86'/0'/${accountIndex}'/0/0`,
  },
  "bitcoin-taproot-testnet": {
    id: "bitcoin-taproot-testnet",
    label: "Bitcoin Taproot Testnet",
    chain: "bitcoin",
    network: "testnet",
    addressType: "taproot",
    path: (accountIndex) => `m/86'/1'/${accountIndex}'/0/0`,
  },
};

export function walletProfile(value: unknown): WalletProfile {
  if (typeof value !== "string" || !WALLET_PROFILE_IDS.includes(value as WalletProfileId)) {
    throw new Error("Wallet profile is required and must be supported");
  }

  return profiles[value as WalletProfileId];
}

export function walletAccountIndex(value: unknown): number {
  const accountIndex = value ?? 0;
  if (
    typeof accountIndex !== "number" ||
    !Number.isSafeInteger(accountIndex) ||
    accountIndex < 0 ||
    accountIndex >= 2 ** 31
  ) {
    throw new Error("Account index must be an integer from 0 through 2^31 - 1");
  }

  return accountIndex;
}

export function evmChainId(profile: WalletProfile, value: unknown): number | undefined {
  if (profile.chain !== "evm") {
    if (value !== undefined) {
      throw new Error("Chain ID is only valid for the EVM wallet profile");
    }

    return undefined;
  }

  const chainId = value ?? 1;
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("Chain ID must be a positive integer");
  }

  return chainId;
}

export function walletDerivationPath(profile: WalletProfile, accountIndex: number): string {
  return profile.path(accountIndex);
}
