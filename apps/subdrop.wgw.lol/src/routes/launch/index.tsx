import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import {
  formatEther,
  formatUnits,
  isAddress,
  parseEther,
  parseUnits,
  zeroAddress,
  type Address,
} from "viem";
import {
  Button,
  Eyebrow,
  ExternalLink,
  Field,
  Ledger,
  Notice,
  TxState,
  inputClass,
} from "../../components/ui";
import { CANNOT_UNWRAP, DEFAULT_FUSES, erc20Abi, nameWrapperAbi, subdropAbi } from "../../lib/abi";
import { isDeployed, publicClientFor } from "../../lib/chains";
import { formatExpiry, parseName, shortAddress } from "../../lib/ens";
import { useTx, useWallet, walletClientFor } from "../../lib/wallet";

export const Route = createFileRoute("/launch/")({
  component: Launch,
});

interface NameState {
  owner: Address;
  fuses: number;
  expiry: bigint;
  approved: boolean;
  drop: DropState | null;
}

interface DropState {
  token: Address;
  symbol: string;
  decimals: number;
  price: bigint;
  reward: bigint;
  maxMints: number;
  minted: number;
  paused: boolean;
  remaining: bigint;
}

type TokenMode = "new" | "existing";

function Launch() {
  const wallet = useWallet();
  const { account, chainConfig } = wallet;
  const deployed = isDeployed(chainConfig);

  const [nameInput, setNameInput] = useState("");
  const parsed = parseName(nameInput);
  const [state, setState] = useState<NameState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((current) => current + 1);

  useEffect(() => {
    if (!parsed || !deployed) {
      setState(null);
      return;
    }

    let cancelled = false;
    const client = publicClientFor(chainConfig);
    const load = async () => {
      const [owner, fuses, expiry] = await client.readContract({
        address: chainConfig.nameWrapper,
        abi: nameWrapperAbi,
        functionName: "getData",
        args: [BigInt(parsed.node)],
      });
      const approved =
        owner === zeroAddress
          ? false
          : await client.readContract({
              address: chainConfig.nameWrapper,
              abi: nameWrapperAbi,
              functionName: "isApprovedForAll",
              args: [owner, chainConfig.subdrop],
            });
      const drop = await loadDrop(client, chainConfig.subdrop, parsed.node);
      if (!cancelled) {
        setState({ owner, fuses, expiry, approved, drop });
        setLoadError(null);
      }
    };

    load().catch((cause: unknown) => {
      if (!cancelled) {
        setLoadError(cause instanceof Error ? cause.message : "Lookup failed.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [parsed?.node, chainConfig, deployed, version]);

  const fuseTx = useTx(chainConfig);
  const approveTx = useTx(chainConfig);

  const ownsName = state !== null && account !== null && state.owner === account;
  const unwrapBurned = state !== null && (state.fuses & CANNOT_UNWRAP) !== 0;
  const ready = ownsName && unwrapBurned && state.approved;

  const burnCannotUnwrap = () => {
    if (!parsed || !account) {
      return;
    }
    void fuseTx.run(
      () =>
        walletClientFor(chainConfig, account).writeContract({
          address: chainConfig.nameWrapper,
          abi: nameWrapperAbi,
          functionName: "setFuses",
          args: [parsed.node, CANNOT_UNWRAP],
        }),
      refresh,
    );
  };

  const approveOperator = () => {
    if (!account) {
      return;
    }
    void approveTx.run(
      () =>
        walletClientFor(chainConfig, account).writeContract({
          address: chainConfig.nameWrapper,
          abi: nameWrapperAbi,
          functionName: "setApprovalForAll",
          args: [chainConfig.subdrop, true],
        }),
      refresh,
    );
  };

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <Eyebrow>Owner console</Eyebrow>
      <h1 className="mt-4 text-5xl md:text-6xl">
        TURN YOUR NAME
        <br />
        INTO A DROP.
      </h1>
      <p className="mt-6 max-w-xl text-muted">
        Three approvals, one form. Subdrop never takes custody of the name or the tokens.
      </p>

      <section className="mt-12 grid gap-6 md:grid-cols-[1fr_auto] md:items-end">
        <Field label="Your wrapped name">
          <input
            className={inputClass}
            placeholder="apple1.eth"
            value={nameInput}
            onChange={(event) => setNameInput(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <WalletControl wallet={wallet} />
      </section>

      {!deployed ? (
        <div className="mt-6">
          <Notice tone="danger">
            Subdrop is not deployed on {chainConfig.chain.name} yet. Switch your wallet to a chain
            listed on the home page.
          </Notice>
        </div>
      ) : null}
      {loadError ? (
        <div className="mt-6">
          <Notice tone="danger">{loadError}</Notice>
        </div>
      ) : null}

      {parsed && state ? (
        <section className="mt-12">
          <h2 className="text-2xl">CHECKLIST.</h2>
          <div className="mt-4">
            <Ledger
              rows={[
                {
                  label: "Wrapped name",
                  value:
                    state.owner === zeroAddress
                      ? "Not wrapped, or not registered."
                      : ownsName
                        ? `Owned by you. Expires ${formatExpiry(state.expiry)}.`
                        : `Owned by ${shortAddress(state.owner)}.`,
                  note:
                    state.owner === zeroAddress ? (
                      <>
                        Wrap it first in the{" "}
                        <ExternalLink href={`${chainConfig.ensApp}/${parsed.name}`}>
                          ENS app
                        </ExternalLink>
                        .
                      </>
                    ) : null,
                },
                {
                  label: "CANNOT_UNWRAP",
                  value: unwrapBurned ? "Burned." : "Not burned.",
                  note: "Required before child names can be locked to their minters.",
                  action:
                    !unwrapBurned && ownsName ? (
                      <Button kind="secondary" onClick={burnCannotUnwrap} disabled={fuseTx.busy}>
                        Burn fuse
                      </Button>
                    ) : null,
                },
                {
                  label: "Operator",
                  value: state.approved ? "Subdrop approved." : "Subdrop not approved.",
                  note: "Lets Subdrop create subnames under this name. Revoke any time.",
                  action:
                    !state.approved && ownsName ? (
                      <Button kind="secondary" onClick={approveOperator} disabled={approveTx.busy}>
                        Approve Subdrop
                      </Button>
                    ) : null,
                },
              ]}
            />
          </div>
          <div className="mt-4 space-y-2">
            <TxState status={fuseTx.status} chainConfig={chainConfig} />
            <TxState status={approveTx.status} chainConfig={chainConfig} />
          </div>
        </section>
      ) : null}

      {parsed && state?.drop ? (
        <ExistingDrop
          name={parsed.name}
          node={parsed.node}
          drop={state.drop}
          ownsName={ownsName}
          onChanged={refresh}
        />
      ) : null}

      {parsed && state && ready && account ? (
        <DropForm
          node={parsed.node}
          name={parsed.name}
          account={account}
          existing={state.drop}
          onChanged={refresh}
        />
      ) : null}
    </main>
  );
}

function WalletControl({ wallet }: { wallet: ReturnType<typeof useWallet> }) {
  if (!wallet.account) {
    return (
      <div>
        <Button onClick={() => void wallet.connect()}>Connect wallet</Button>
        {wallet.error ? <p className="mt-2 text-xs text-danger">{wallet.error}</p> : null}
      </div>
    );
  }

  return (
    <div className="text-sm">
      <p>{shortAddress(wallet.account)}</p>
      <p className="text-xs text-muted">
        {wallet.supported ? wallet.chainConfig.chain.name : `Unsupported chain ${wallet.chainId}`}
      </p>
    </div>
  );
}

function ExistingDrop({
  name,
  node,
  drop,
  ownsName,
  onChanged,
}: {
  name: string;
  node: `0x${string}`;
  drop: DropState;
  ownsName: boolean;
  onChanged: () => void;
}) {
  const { account, chainConfig } = useWallet();
  const pauseTx = useTx(chainConfig);

  const togglePause = () => {
    if (!account) {
      return;
    }
    void pauseTx.run(
      () =>
        walletClientFor(chainConfig, account).writeContract({
          address: chainConfig.subdrop,
          abi: subdropAbi,
          functionName: "setPaused",
          args: [node, !drop.paused],
        }),
      onChanged,
    );
  };

  return (
    <section className="mt-12">
      <h2 className="text-2xl">LIVE DROP.</h2>
      <div className="mt-4">
        <Ledger
          rows={[
            {
              label: "Token",
              value: (
                <ExternalLink href={`${chainConfig.explorer}/token/${drop.token}`}>
                  {drop.symbol}
                </ExternalLink>
              ),
              note: drop.token,
            },
            {
              label: "Price",
              value: `${formatEther(drop.price)} ETH per mint`,
            },
            {
              label: "Reward",
              value: `${formatUnits(drop.reward, drop.decimals)} ${drop.symbol} per mint`,
            },
            {
              label: "Minted",
              value: drop.maxMints === 0 ? `${drop.minted}` : `${drop.minted} of ${drop.maxMints}`,
              note: `${formatRemaining(drop.remaining)} more can be minted with the current budget.`,
            },
            {
              label: "Status",
              value: drop.paused ? "Paused." : "Open.",
              action: ownsName ? (
                <Button kind="secondary" onClick={togglePause} disabled={pauseTx.busy}>
                  {drop.paused ? "Resume" : "Pause"}
                </Button>
              ) : null,
            },
          ]}
        />
      </div>
      <div className="mt-4">
        <TxState status={pauseTx.status} chainConfig={chainConfig} />
      </div>
      <p className="mt-4 text-sm text-muted">
        Mint page:{" "}
        <Link to="/mint/$name" params={{ name }} className="text-ink underline underline-offset-4">
          /mint/{name}
        </Link>
      </p>
    </section>
  );
}

function DropForm({
  node,
  name,
  account,
  existing,
  onChanged,
}: {
  node: `0x${string}`;
  name: string;
  account: Address;
  existing: DropState | null;
  onChanged: () => void;
}) {
  const { chainConfig } = useWallet();
  const submitTx = useTx(chainConfig);
  const budgetTx = useTx(chainConfig);

  const [mode, setMode] = useState<TokenMode>(existing ? "existing" : "new");
  const [tokenName, setTokenName] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState("");
  const [supply, setSupply] = useState("1000000");
  const [tokenAddress, setTokenAddress] = useState(existing?.token ?? "");
  const [budget, setBudget] = useState("");
  const [price, setPrice] = useState(existing ? formatEther(existing.price) : "0.001");
  const [reward, setReward] = useState(
    existing ? formatUnits(existing.reward, existing.decimals) : "100",
  );
  const [maxMints, setMaxMints] = useState(existing ? String(existing.maxMints) : "0");
  const [formError, setFormError] = useState<string | null>(null);

  const [tokenInfo, setTokenInfo] = useState<{
    symbol: string;
    decimals: number;
    allowance: bigint;
  } | null>(null);
  useEffect(() => {
    if (mode !== "existing" || !isAddress(tokenAddress)) {
      setTokenInfo(null);
      return;
    }

    let cancelled = false;
    const client = publicClientFor(chainConfig);
    const load = async () => {
      const [symbol, decimals, allowance] = await Promise.all([
        client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "decimals" }),
        client.readContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "allowance",
          args: [account, chainConfig.subdrop],
        }),
      ]);
      if (!cancelled) {
        setTokenInfo({ symbol, decimals, allowance });
      }
    };
    load().catch(() => {
      if (!cancelled) {
        setTokenInfo(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [mode, tokenAddress, account, chainConfig, budgetTx.status.state]);

  const decimals = tokenInfo?.decimals ?? 18;

  const approveBudget = () => {
    if (!isAddress(tokenAddress)) {
      return;
    }
    let amount: bigint;
    try {
      amount = parseUnits(budget, decimals);
    } catch {
      setFormError("Budget must be a token amount.");
      return;
    }
    setFormError(null);
    void budgetTx.run(() =>
      walletClientFor(chainConfig, account).writeContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "approve",
        args: [chainConfig.subdrop, amount],
      }),
    );
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();

    let priceWei: bigint;
    let rewardUnits: bigint;
    let cap: number;
    try {
      priceWei = parseEther(price);
      rewardUnits = parseUnits(reward, decimals);
      cap = Number.parseInt(maxMints, 10);
    } catch {
      setFormError("Price and reward must be numbers.");
      return;
    }
    if (!Number.isInteger(cap) || cap < 0) {
      setFormError("Cap must be a whole number. Zero means no cap.");
      return;
    }
    if (mode === "existing" && !isAddress(tokenAddress)) {
      setFormError("Token must be a contract address.");
      return;
    }
    if (mode === "new" && (tokenName.trim().length === 0 || tokenSymbol.trim().length === 0)) {
      setFormError("Give the new token a name and a symbol.");
      return;
    }
    setFormError(null);

    const config = {
      token: mode === "existing" && isAddress(tokenAddress) ? tokenAddress : zeroAddress,
      feeRecipient: account,
      price: priceWei,
      reward: rewardUnits,
      fuses: DEFAULT_FUSES,
      maxMints: cap,
    };
    const wallet = walletClientFor(chainConfig, account);

    void submitTx.run(
      () =>
        mode === "new"
          ? wallet.writeContract({
              address: chainConfig.subdrop,
              abi: subdropAbi,
              functionName: "launch",
              args: [node, tokenName.trim(), tokenSymbol.trim(), parseUnits(supply, 18), config],
            })
          : wallet.writeContract({
              address: chainConfig.subdrop,
              abi: subdropAbi,
              functionName: "configure",
              args: [node, config],
            }),
      onChanged,
    );
  };

  return (
    <section className="mt-12">
      <h2 className="text-2xl">{existing ? "UPDATE THE DROP." : "SET UP THE DROP."}</h2>
      <form
        onSubmit={onSubmit}
        className="mt-4 grid gap-6 border border-line bg-surface p-6 md:grid-cols-2"
      >
        <div className="md:col-span-2 flex gap-6 text-xs uppercase tracking-[0.15em]">
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} />
            New token
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={mode === "existing"}
              onChange={() => setMode("existing")}
            />
            Existing token
          </label>
        </div>

        {mode === "new" ? (
          <>
            <Field label="Token name">
              <input
                className={inputClass}
                value={tokenName}
                onChange={(event) => setTokenName(event.target.value)}
                placeholder="Apple One"
              />
            </Field>
            <Field label="Symbol">
              <input
                className={inputClass}
                value={tokenSymbol}
                onChange={(event) => setTokenSymbol(event.target.value)}
                placeholder="APPLE1"
              />
            </Field>
            <Field
              label="Total supply"
              hint="Minted to your wallet. 18 decimals. Subdrop gets an allowance from it."
            >
              <input
                className={inputClass}
                value={supply}
                onChange={(event) => setSupply(event.target.value)}
                inputMode="decimal"
              />
            </Field>
          </>
        ) : (
          <>
            <Field
              label="Token address"
              hint={
                tokenInfo
                  ? `${tokenInfo.symbol}, ${tokenInfo.decimals} decimals`
                  : "An ERC20 you hold."
              }
            >
              <input
                className={inputClass}
                value={tokenAddress}
                onChange={(event) => setTokenAddress(event.target.value)}
                placeholder="0x…"
                spellCheck={false}
              />
            </Field>
            <Field
              label="Reward budget"
              hint={
                tokenInfo
                  ? `Current allowance: ${formatUnits(tokenInfo.allowance, tokenInfo.decimals)} ${tokenInfo.symbol}.`
                  : "Approve how much Subdrop may pull for rewards."
              }
            >
              <div className="flex gap-2">
                <input
                  className={inputClass}
                  value={budget}
                  onChange={(event) => setBudget(event.target.value)}
                  inputMode="decimal"
                  placeholder="10000"
                />
                <Button
                  kind="secondary"
                  onClick={approveBudget}
                  disabled={!tokenInfo || budgetTx.busy}
                >
                  Approve
                </Button>
              </div>
            </Field>
          </>
        )}

        <Field label="Price (ETH)" hint="Paid to your wallet on every mint. Zero is allowed.">
          <input
            className={inputClass}
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            inputMode="decimal"
          />
        </Field>
        <Field label="Reward per mint" hint="Tokens the minter receives.">
          <input
            className={inputClass}
            value={reward}
            onChange={(event) => setReward(event.target.value)}
            inputMode="decimal"
          />
        </Field>
        <Field label="Cap" hint="Maximum number of mints. Zero means no cap.">
          <input
            className={inputClass}
            value={maxMints}
            onChange={(event) => setMaxMints(event.target.value)}
            inputMode="numeric"
          />
        </Field>

        <div className="md:col-span-2 space-y-3">
          {formError ? <Notice tone="danger">{formError}</Notice> : null}
          <TxState status={budgetTx.status} chainConfig={chainConfig} />
          <TxState status={submitTx.status} chainConfig={chainConfig} />
          <div className="flex items-center justify-between gap-4">
            <span className="text-xs text-muted">
              Child names get PARENT_CANNOT_CONTROL and CANNOT_UNWRAP.
            </span>
            <Button type="submit" disabled={submitTx.busy}>
              {existing
                ? "Update drop"
                : mode === "new"
                  ? "Launch token and drop"
                  : "Configure drop"}
            </Button>
          </div>
        </div>
      </form>
      <p className="mt-4 text-sm text-muted">
        Drop for <span className="text-ink">{name}</span> on {chainConfig.chain.name}.
      </p>
    </section>
  );
}

async function loadDrop(
  client: ReturnType<typeof publicClientFor>,
  subdrop: Address,
  node: `0x${string}`,
): Promise<DropState | null> {
  const [, token, , price, reward, , maxMints, minted, paused] = await client.readContract({
    address: subdrop,
    abi: subdropAbi,
    functionName: "drops",
    args: [node],
  });
  if (token === zeroAddress) {
    return null;
  }

  const [symbol, decimals, remaining] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({
      address: subdrop,
      abi: subdropAbi,
      functionName: "remaining",
      args: [node],
    }),
  ]);

  return { token, symbol, decimals, price, reward, maxMints, minted, paused, remaining };
}

function formatRemaining(remaining: bigint): string {
  return remaining > 1_000_000_000n ? "Unlimited" : remaining.toString();
}
