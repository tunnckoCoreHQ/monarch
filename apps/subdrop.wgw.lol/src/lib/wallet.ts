import { useCallback, useEffect, useState } from "react";
import { createWalletClient, custom, type Address, type EIP1193Provider, type Hex } from "viem";
import { chainConfigFor, isSupportedChain, publicClientFor, type ChainConfig } from "./chains";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export interface Wallet {
  account: Address | null;
  chainId: number | null;
  chainConfig: ChainConfig;
  supported: boolean;
  error: string | null;
  connect: () => Promise<void>;
  switchChain: (chainId: number) => Promise<void>;
}

export function useWallet(): Wallet {
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider) {
      return;
    }

    const onAccounts = (accounts: readonly Address[]) => {
      setAccount(accounts[0] ?? null);
    };
    const onChain = (hex: string) => {
      setChainId(Number(hex));
    };

    void provider
      .request({ method: "eth_accounts" })
      .then(onAccounts)
      .catch(() => undefined);
    void provider
      .request({ method: "eth_chainId" })
      .then(onChain)
      .catch(() => undefined);
    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChain);

    return () => {
      provider.removeListener("accountsChanged", onAccounts);
      provider.removeListener("chainChanged", onChain);
    };
  }, []);

  const connect = useCallback(async () => {
    const provider = window.ethereum;
    if (!provider) {
      setError("No wallet found. Install a browser wallet and reload.");
      return;
    }

    try {
      const client = createWalletClient({ transport: custom(provider) });
      const [address] = await client.requestAddresses();
      setAccount(address ?? null);
      setChainId(await client.getChainId());
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  const switchChain = useCallback(async (target: number) => {
    const provider = window.ethereum;
    if (!provider) {
      return;
    }

    const client = createWalletClient({ transport: custom(provider) });
    await client.switchChain({ id: target });
    setChainId(target);
  }, []);

  return {
    account,
    chainId,
    chainConfig: chainConfigFor(chainId),
    supported: isSupportedChain(chainId),
    error,
    connect,
    switchChain,
  };
}

export type TxStatus =
  | { state: "idle" }
  | { state: "signing" }
  | { state: "pending"; hash: Hex }
  | { state: "confirmed"; hash: Hex }
  | { state: "failed"; message: string };

export interface TxRunner {
  status: TxStatus;
  busy: boolean;
  run: (send: () => Promise<Hex>, onConfirmed?: () => void) => Promise<void>;
  reset: () => void;
}

/** Tracks one transaction through signing, mining, and confirmation. */
export function useTx(chainConfig: ChainConfig): TxRunner {
  const [status, setStatus] = useState<TxStatus>({ state: "idle" });

  const run = useCallback(
    async (send: () => Promise<Hex>, onConfirmed?: () => void) => {
      setStatus({ state: "signing" });
      try {
        const hash = await send();
        setStatus({ state: "pending", hash });

        const receipt = await publicClientFor(chainConfig).waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          setStatus({ state: "failed", message: "Transaction reverted on chain." });
          return;
        }

        setStatus({ state: "confirmed", hash });
        onConfirmed?.();
      } catch (cause) {
        setStatus({ state: "failed", message: errorMessage(cause) });
      }
    },
    [chainConfig],
  );

  const reset = useCallback(() => {
    setStatus({ state: "idle" });
  }, []);

  const busy = status.state === "signing" || status.state === "pending";

  return { status, busy, run, reset };
}

export function walletClientFor(chainConfig: ChainConfig, account: Address) {
  const provider = window.ethereum;
  if (!provider) {
    throw new Error("No wallet found.");
  }

  return createWalletClient({ account, chain: chainConfig.chain, transport: custom(provider) });
}

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    const firstLine = cause.message.split("\n")[0] ?? cause.message;
    return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
  }

  return "Something went wrong.";
}
