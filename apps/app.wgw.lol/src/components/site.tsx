import { getRouteApi, Link, useLocation, useRouter } from "@tanstack/react-router";
import { Check, CircleAlert, CircleCheck, CircleDot, CircleX, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import {
  ApiError,
  type CombinedState,
  type CombinedStatus,
  type Me,
  type StatusState,
} from "~/lib/api";
import { cn } from "~/lib/utils";

const rootRoute = getRouteApi("__root__");

/** The signed-in account, or null. The root loader may not have run on a not-found page. */
export function useMe(): Me | null {
  return rootRoute.useMatch({ select: (match) => match.loaderData?.me ?? null });
}

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto max-w-6xl px-6 py-10", className)}>{children}</div>;
}

export function Kicker({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("text-signal font-mono text-xs tracking-[0.2em] uppercase", className)}>
      {children}
    </p>
  );
}

/** One eyebrow, one display heading, one short line of copy, and optional actions. */
export function PageHeader({
  kicker,
  title,
  children,
  actions,
  danger = false,
}: {
  kicker: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  danger?: boolean;
}) {
  return (
    <header className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <Kicker className={danger ? "text-destructive" : undefined}>{kicker}</Kicker>
        <h1 className="mt-3 text-5xl leading-[0.95] font-black tracking-[-0.035em] text-balance wrap-anywhere md:text-6xl">
          {title}
        </h1>
        {children === undefined ? null : (
          <p className="text-muted-foreground mt-4 max-w-xl text-pretty">{children}</p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>
      )}
    </header>
  );
}

export function Section({
  title,
  description,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-4", className)}>
      <div>
        <h2 className="text-2xl font-black tracking-tight">{title}</h2>
        {description === undefined ? null : (
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm text-pretty">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint === undefined ? null : <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

/** Label and value pairs, one `LedgerRow` per pair. */
export function Ledger({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("bg-card divide-y border font-mono text-sm", className)}>{children}</dl>;
}

export function LedgerRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-4 px-4 py-2.5">
      <dt className="text-muted-foreground pt-0.5 text-xs tracking-wider uppercase">{term}</dt>
      <dd className="wrap-anywhere">{children}</dd>
    </div>
  );
}

/** A small number next to a tab or heading label. */
export function Count({ value }: { value: number }) {
  return (
    <span className="bg-secondary text-foreground px-1.5 font-mono text-[11px] leading-5 tracking-normal">
      {value}
    </span>
  );
}

/**
 * Shows `children`, or the value when there are none, and copies the value. Below md the text
 * wraps, so its end stays in view; from md up it stays on one line and scrolls.
 */
export function CopyField({
  value,
  label,
  children,
}: {
  value: string;
  label?: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="bg-card flex min-w-0 items-stretch border font-mono text-xs">
      {label === undefined ? null : (
        <span className="text-muted-foreground flex shrink-0 items-center border-r px-2.5 text-[11px] tracking-wider uppercase">
          {label}
        </span>
      )}
      <code
        title={value}
        className="min-w-0 flex-1 [scrollbar-width:none] overflow-x-auto px-3 py-2.5 break-all select-all md:[mask-image:linear-gradient(to_right,black_90%,transparent)] md:break-normal md:whitespace-nowrap"
      >
        {children ?? value}
      </code>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy"}
        className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-10 shrink-0 cursor-pointer items-center justify-center border-l focus-visible:-outline-offset-2"
        onClick={fire(async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })}
      >
        {copied ? <Check className="text-signal size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

export function Terminal({ children, title }: { children: string; title?: string }) {
  // Inline-size containment keeps long commands from widening a grid or flex parent.
  return (
    <div className="bg-card min-w-0 border contain-inline-size">
      {title === undefined ? null : (
        <div className="text-muted-foreground border-b px-3 py-1.5 font-mono text-[11px] tracking-wider uppercase">
          {title}
        </div>
      )}
      <pre className="text-foreground/90 overflow-x-auto p-4 font-mono text-[12.5px] leading-6">
        {children}
      </pre>
    </div>
  );
}

const STATUS_ICONS = {
  success: { Icon: CircleCheck, color: "text-signal" },
  failure: { Icon: CircleX, color: "text-destructive" },
  error: { Icon: CircleAlert, color: "text-destructive" },
  pending: { Icon: CircleDot, color: "text-muted-foreground" },
} as const;

/** The icon of one commit status. */
export function StatusIcon({ state, className }: { state: StatusState; className?: string }) {
  const { Icon, color } = STATUS_ICONS[state];
  return <Icon role="img" aria-label={state} className={cn("size-3.5", color, className)} />;
}

const STATUS_BADGE = { success: "signal", failure: "destructive", pending: "outline" } as const;

/** The combined state of a commit's statuses. Nothing when it has none. */
export function StatusBadge({ state }: { state: CombinedState }) {
  if (state === null) {
    return null;
  }
  return (
    <Badge variant={STATUS_BADGE[state]} title={`Checks: ${state}`}>
      {state}
    </Badge>
  );
}

const STATUS_DOT = {
  success: "bg-signal",
  failure: "bg-destructive",
  pending: "bg-faint",
} as const;

/** A small square in the color of the combined state. Nothing when there are no statuses. */
export function StatusDot({ state, className }: { state: CombinedState; className?: string }) {
  if (state === null) {
    return null;
  }
  return (
    <span
      role="img"
      aria-label={`checks ${state}`}
      title={`Checks: ${state}`}
      className={cn("inline-block size-2 shrink-0", STATUS_DOT[state], className)}
    />
  );
}

/** Each status of a commit, with the combined state on top. */
export function Checks({ status, className }: { status: CombinedStatus; className?: string }) {
  return (
    <section aria-label="Checks" className={cn("min-w-0", className)}>
      <div className="flex items-center justify-between gap-2 px-4 py-2.5">
        <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">Checks</p>
        <StatusBadge state={status.state} />
      </div>
      <ul className="divide-y border-t">
        {status.statuses.map((item) => (
          <li key={item.context} className="flex items-start gap-2.5 px-4 py-2.5">
            <StatusIcon state={item.state} className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-mono text-xs font-semibold wrap-anywhere">{item.context}</p>
              {item.description === "" ? null : (
                <p className="text-muted-foreground mt-0.5 text-xs wrap-anywhere">
                  {item.description}
                </p>
              )}
            </div>
            {item.target_url === null ? null : (
              // The API takes https links only.
              <a
                href={item.target_url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="text-signal shrink-0 font-mono text-xs underline-offset-4 hover:underline"
              >
                Details
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (error === null) {
    return null;
  }
  return (
    <p
      role="alert"
      className="border-destructive bg-destructive/10 text-destructive border-l-2 px-3 py-2 font-mono text-xs wrap-anywhere"
    >
      {error}
    </p>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="border border-dashed px-6 py-12 text-center">
      <p className="text-muted-foreground font-mono text-sm text-balance">{children}</p>
      {action === undefined ? null : <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

const SKELETON_WIDTHS = ["44%", "28%", "60%", "36%", "52%"];

/** The loading state of a route: a status line over a placeholder list. */
export function Pending({ label = "Loading" }: { label?: string }) {
  return (
    <Page>
      <p
        role="status"
        className="text-muted-foreground flex items-center gap-2 font-mono text-xs tracking-[0.2em] uppercase"
      >
        <span aria-hidden className="bg-signal size-2 motion-safe:animate-pulse" />
        {label}
      </p>
      <div aria-hidden className="mt-6 divide-y border">
        {SKELETON_WIDTHS.map((width) => (
          <div key={width} className="flex h-11 items-center px-4">
            <span className="bg-muted h-2.5" style={{ width }} />
          </div>
        ))}
      </div>
    </Page>
  );
}

interface ErrorCopy {
  title: string;
  text: string;
}

function sentence(message: string): string {
  const text = message.trim();
  if (text === "") {
    return "No details.";
  }
  const capitalized = `${text[0].toUpperCase()}${text.slice(1)}`;
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

function errorCopy(status: number | null, message: string, notFound?: ErrorCopy): ErrorCopy {
  if (status === 401) {
    return { title: "Sign in first.", text: "This page needs an account." };
  }
  if (status === 403) {
    return { title: "No access.", text: sentence(message) };
  }
  if (status === 404) {
    return notFound ?? { title: "Not found.", text: sentence(message) };
  }
  return { title: "Something broke.", text: sentence(message) };
}

/** The error state of a route. `notFound` replaces the copy for a 404. */
export function RouteError({ error, notFound }: { error: unknown; notFound?: ErrorCopy }) {
  const router = useRouter();
  const href = useLocation({ select: (location) => location.href });
  const me = useMe();
  const status = error instanceof ApiError ? error.status : null;
  const copy = errorCopy(status, messageOf(error), notFound);
  // A private repository looks missing to outsiders, so a 404 also offers to sign in.
  const offerSignIn = status === 401 || (status === 404 && me === null);
  const offerRetry = status === null || status >= 500;

  return (
    <Page className="py-16 md:py-24">
      <PageHeader danger kicker={status === null ? "error" : `error ${status}`} title={copy.title}>
        {copy.text}
      </PageHeader>
      <div className="mt-8 flex flex-wrap gap-3">
        {offerSignIn ? (
          <Button asChild size="lg">
            <a href={`/login?return_to=${encodeURIComponent(href)}`}>Sign in</a>
          </Button>
        ) : null}
        {offerRetry ? (
          <Button size="lg" onClick={fire(() => router.invalidate())}>
            Try again
          </Button>
        ) : null}
        <Button asChild size="lg" variant="outline">
          <Link to="/explore">Explore public repositories</Link>
        </Button>
      </div>
    </Page>
  );
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs an async handler from a React event and reports its failure instead of returning a promise. */
export function fire<A extends unknown[]>(
  handler: (...args: A) => Promise<unknown>,
): (...args: A) => void {
  return (...args) => {
    handler(...args).catch((error: unknown) => console.error(error));
  };
}
