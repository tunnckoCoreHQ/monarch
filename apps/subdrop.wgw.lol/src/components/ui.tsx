import type { ReactNode } from "react";
import type { ChainConfig } from "../lib/chains";
import type { TxStatus } from "../lib/wallet";

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-xs uppercase tracking-[0.2em] text-accent">{children}</p>;
}

export interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: "primary" | "secondary";
  type?: "button" | "submit";
}

export function Button({
  children,
  onClick,
  disabled = false,
  kind = "primary",
  type = "button",
}: ButtonProps) {
  const tone =
    kind === "primary"
      ? "bg-accent text-field hover:bg-ink disabled:bg-raised disabled:text-muted"
      : "border border-edge text-ink hover:border-accent disabled:border-line disabled:text-muted";

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`min-h-11 px-5 text-xs font-bold uppercase tracking-[0.15em] ${tone}`}
    >
      {children}
    </button>
  );
}

export interface FieldProps {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}

export function Field({ label, hint, children }: FieldProps) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-[0.15em] text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "w-full border border-line bg-surface px-3 py-2.5 text-ink placeholder:text-muted/60 focus:border-edge";

export interface LedgerRow {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  action?: ReactNode;
}

export function Ledger({ rows }: { rows: LedgerRow[] }) {
  return (
    <dl className="border-t border-line">
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid gap-2 border-b border-line py-4 md:grid-cols-[10rem_1fr_auto] md:gap-6"
        >
          <dt className="text-xs uppercase tracking-[0.15em] text-muted">{row.label}</dt>
          <dd className="min-w-0 break-words">
            <div>{row.value}</div>
            {row.note ? <p className="mt-1 text-sm text-muted">{row.note}</p> : null}
          </dd>
          {row.action ? <div className="md:justify-self-end">{row.action}</div> : null}
        </div>
      ))}
    </dl>
  );
}

export function Notice({
  tone,
  children,
}: {
  tone: "info" | "danger" | "ok";
  children: ReactNode;
}) {
  const color =
    tone === "danger" ? "border-danger text-danger" : tone === "ok" ? "border-ok" : "border-edge";

  return (
    <p role="status" className={`border-l-2 pl-3 text-sm ${color}`}>
      {children}
    </p>
  );
}

export function TxState({ status, chainConfig }: { status: TxStatus; chainConfig: ChainConfig }) {
  if (status.state === "idle") {
    return null;
  }
  if (status.state === "signing") {
    return <Notice tone="info">Confirm in your wallet.</Notice>;
  }
  if (status.state === "failed") {
    return <Notice tone="danger">{status.message}</Notice>;
  }

  const link = (
    <a
      className="underline decoration-edge underline-offset-4"
      href={`${chainConfig.explorer}/tx/${status.hash}`}
      target="_blank"
      rel="noreferrer"
    >
      view transaction
    </a>
  );
  if (status.state === "pending") {
    return <Notice tone="info">Waiting for confirmation. {link}</Notice>;
  }

  return <Notice tone="ok">Confirmed. {link}</Notice>;
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="underline decoration-edge underline-offset-4 hover:decoration-accent"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  );
}
