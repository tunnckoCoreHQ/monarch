import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { formatEther, formatUnits, zeroAddress, type Address, type Hex } from "viem";
import {
  Button,
  Eyebrow,
  ExternalLink,
  Ledger,
  Notice,
  TxState,
  inputClass,
} from "../../components/ui";
import { erc20Abi, nameWrapperAbi, subdropAbi } from "../../lib/abi";
import { isDeployed, publicClientFor } from "../../lib/chains";
import { formatExpiry, parseLabel, parseName } from "../../lib/ens";
import { useTx, useWallet, walletClientFor } from "../../lib/wallet";

export const Route = createFileRoute("/mint/$name")({
  component: Mint,
});

interface DropView {
  token: Address;
  symbol: string;
  decimals: number;
  price: bigint;
  reward: bigint;
  maxMints: number;
  minted: number;
  paused: boolean;
  remaining: bigint;
  parentExpiry: bigint;
}

type Availability = "idle" | "checking" | "free" | "taken" | "invalid";

function Mint() {
  const { name } = Route.useParams();
  const parsed = parseName(name);
  const wallet = useWallet();
  const { account, chainConfig } = wallet;
  const deployed = isDeployed(chainConfig);

  const [drop, setDrop] = useState<DropView | null | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((current) => current + 1);

  useEffect(() => {
    if (!parsed || !deployed) {
      setDrop(null);
      return;
    }

    let cancelled = false;
    const load = async () => {
      const view = await loadDrop(chainConfig, parsed.node);
      if (!cancelled) {
        setDrop(view);
      }
    };
    load().catch(() => {
      if (!cancelled) {
        setDrop(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [parsed?.node, chainConfig, deployed, version]);

  const [labelInput, setLabelInput] = useState("");
  const label = parseLabel(labelInput);
  const [availability, setAvailability] = useState<Availability>("idle");

  useEffect(() => {
    if (!parsed || !deployed || labelInput.trim().length === 0) {
      setAvailability("idle");
      return;
    }
    if (!label) {
      setAvailability("invalid");
      return;
    }

    let cancelled = false;
    setAvailability("checking");
    const timer = setTimeout(() => {
      publicClientFor(chainConfig)
        .readContract({
          address: chainConfig.subdrop,
          abi: subdropAbi,
          functionName: "available",
          args: [parsed.node, label],
        })
        .then((free) => {
          if (!cancelled) {
            setAvailability(free ? "free" : "taken");
          }
        })
        .catch(() => {
          if (!cancelled) {
            setAvailability("invalid");
          }
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [label, labelInput, parsed?.node, chainConfig, deployed]);

  const mintTx = useTx(chainConfig);
  const [mintedLabel, setMintedLabel] = useState<string | null>(null);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!parsed || !drop || !label || !account || availability !== "free") {
      return;
    }

    const minting = label;
    void mintTx.run(
      () =>
        walletClientFor(chainConfig, account).writeContract({
          address: chainConfig.subdrop,
          abi: subdropAbi,
          functionName: "mint",
          args: [parsed.node, minting],
          value: drop.price,
        }),
      () => {
        setMintedLabel(minting);
        refresh();
      },
    );
  };

  if (!parsed) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-16">
        <h1 className="text-5xl">NOT A NAME.</h1>
        <p className="mt-6 text-muted">
          <span className="text-ink">{name}</span> is not a valid ENS name.
        </p>
      </main>
    );
  }

  const canMint =
    drop !== null &&
    drop !== undefined &&
    !drop.paused &&
    drop.remaining > 0n &&
    availability === "free" &&
    !mintTx.busy;

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <Eyebrow>Mint under {parsed.name}</Eyebrow>
      <h1 className="mt-4 text-5xl md:text-6xl">
        CLAIM A NAME.
        <br />
        TAKE THE REWARD.
      </h1>

      {!deployed ? (
        <div className="mt-8">
          <Notice tone="danger">
            Subdrop is not deployed on {chainConfig.chain.name} yet. Switch your wallet to a chain
            listed on the home page.
          </Notice>
        </div>
      ) : null}

      {deployed && drop === undefined ? <p className="mt-8 text-muted">Loading drop…</p> : null}

      {deployed && drop === null ? (
        <div className="mt-8">
          <Notice tone="info">
            No drop is configured for {parsed.name} on {chainConfig.chain.name}.{" "}
            <Link to="/launch" className="text-ink underline underline-offset-4">
              Own it? Launch one.
            </Link>
          </Notice>
        </div>
      ) : null}

      {drop ? (
        <section className="mt-12 grid gap-12 md:grid-cols-[1fr_1fr]">
          <div>
            <h2 className="text-2xl">THE DEAL.</h2>
            <div className="mt-4">
              <Ledger
                rows={[
                  { label: "You pay", value: `${formatEther(drop.price)} ETH` },
                  {
                    label: "You get",
                    value: `${formatUnits(drop.reward, drop.decimals)} ${drop.symbol}`,
                    note: (
                      <ExternalLink href={`${chainConfig.explorer}/token/${drop.token}`}>
                        {drop.token}
                      </ExternalLink>
                    ),
                  },
                  {
                    label: "Left",
                    value: drop.paused ? "Paused." : formatRemaining(drop.remaining),
                    note:
                      drop.maxMints === 0
                        ? `${drop.minted} minted so far.`
                        : `${drop.minted} of ${drop.maxMints} minted.`,
                  },
                  {
                    label: "Expires",
                    value: formatExpiry(drop.parentExpiry),
                    note: "Your subname lives as long as the parent name does.",
                  },
                ]}
              />
            </div>
          </div>

          <form onSubmit={onSubmit} className="self-start border border-line bg-surface p-6">
            <label className="block text-xs uppercase tracking-[0.15em] text-muted" htmlFor="label">
              Pick your label
            </label>
            <div className="mt-2 flex items-center border border-line bg-field">
              <input
                id="label"
                className={`${inputClass} border-0 bg-transparent`}
                placeholder="dan"
                value={labelInput}
                onChange={(event) => setLabelInput(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <span className="shrink-0 px-3 text-muted">.{parsed.name}</span>
            </div>
            <p className="mt-2 min-h-5 text-xs" aria-live="polite">
              <AvailabilityText availability={availability} />
            </p>

            <div className="mt-6 space-y-3">
              {!account ? (
                <Button onClick={() => void wallet.connect()}>Connect wallet</Button>
              ) : !wallet.supported ? (
                <Notice tone="danger">Switch your wallet to a supported chain.</Notice>
              ) : (
                <Button type="submit" disabled={!canMint}>
                  Mint for {formatEther(drop.price)} ETH
                </Button>
              )}
              {wallet.error ? <Notice tone="danger">{wallet.error}</Notice> : null}
              <TxState status={mintTx.status} chainConfig={chainConfig} />
              {mintedLabel && mintTx.status.state === "confirmed" ? (
                <MintedResult
                  fullName={`${mintedLabel}.${parsed.name}`}
                  ensApp={chainConfig.ensApp}
                  reward={`${formatUnits(drop.reward, drop.decimals)} ${drop.symbol}`}
                  hash={mintTx.status.hash}
                />
              ) : null}
            </div>
          </form>
        </section>
      ) : null}
    </main>
  );
}

function AvailabilityText({ availability }: { availability: Availability }) {
  if (availability === "checking") {
    return <span className="text-muted">Checking…</span>;
  }
  if (availability === "free") {
    return <span className="text-ok">Available.</span>;
  }
  if (availability === "taken") {
    return <span className="text-danger">Taken.</span>;
  }
  if (availability === "invalid") {
    return <span className="text-danger">Not a valid label.</span>;
  }

  return null;
}

function MintedResult({
  fullName,
  ensApp,
  reward,
  hash,
}: {
  fullName: string;
  ensApp: string;
  reward: string;
  hash: Hex;
}) {
  return (
    <div className="border-t border-line pt-4 text-sm">
      <p>
        <span className="text-ink">{fullName}</span> is yours, and {reward} is in your wallet.
      </p>
      <p className="mt-2 text-muted">
        <ExternalLink href={`${ensApp}/${fullName}`}>Open in the ENS app</ExternalLink>
        <span className="sr-only">{hash}</span>
      </p>
    </div>
  );
}

async function loadDrop(
  chainConfig: ReturnType<typeof useWallet>["chainConfig"],
  node: Hex,
): Promise<DropView | null> {
  const client = publicClientFor(chainConfig);
  const [, token, , price, reward, , maxMints, minted, paused] = await client.readContract({
    address: chainConfig.subdrop,
    abi: subdropAbi,
    functionName: "drops",
    args: [node],
  });
  if (token === zeroAddress) {
    return null;
  }

  const [symbol, decimals, remaining, parentData] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({
      address: chainConfig.subdrop,
      abi: subdropAbi,
      functionName: "remaining",
      args: [node],
    }),
    client.readContract({
      address: chainConfig.nameWrapper,
      abi: nameWrapperAbi,
      functionName: "getData",
      args: [BigInt(node)],
    }),
  ]);

  return {
    token,
    symbol,
    decimals,
    price,
    reward,
    maxMints,
    minted,
    paused,
    remaining,
    parentExpiry: parentData[2],
  };
}

function formatRemaining(remaining: bigint): string {
  return remaining > 1_000_000_000n ? "Unlimited" : remaining.toString();
}
