import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import {
  ErrorNote,
  Field,
  Ledger,
  LedgerRow,
  messageOf,
  Page,
  PageHeader,
  fire,
} from "~/components/site";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { api, ApiError } from "~/lib/api";
import { cn, pageTitle } from "~/lib/utils";

export const Route = createFileRoute("/device")({
  validateSearch: (search: Record<string, unknown>): { code?: string } => ({
    code: typeof search.code === "string" ? search.code : undefined,
  }),
  head: () => ({ meta: [{ title: pageTitle("CLI sign-in") }] }),
  component: Device,
});

function Device() {
  const search = Route.useSearch();
  const [code, setCode] = useState(search.code ?? "");
  const [info, setInfo] = useState<{ client_name: string; status: string } | null>(null);
  const [decision, setDecision] = useState<"approved" | "denied" | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookup = async (event: React.FormEvent) => {
    event.preventDefault();
    setChecking(true);
    setError(null);
    try {
      setInfo(await api(`/api/device/${encodeURIComponent(code.trim())}`));
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        window.location.assign(
          `/login?return_to=${encodeURIComponent(`/device?code=${code.trim()}`)}`,
        );
        return;
      }
      setError(messageOf(caught));
    } finally {
      setChecking(false);
    }
  };

  const decide = async (approve: boolean) => {
    try {
      await api(`/api/device/${encodeURIComponent(code.trim())}`, {
        method: "POST",
        json: { approve },
      });
      setDecision(approve ? "approved" : "denied");
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  return (
    <Page className="max-w-2xl py-16">
      <PageHeader kicker="cli sign-in" title="Connect a terminal.">
        Enter the code that <code className="text-foreground font-mono text-sm">wgw login</code>{" "}
        printed. Approving it creates a 90-day API key for that terminal.
      </PageHeader>
      {decision !== null ? (
        <p
          role="status"
          className={cn(
            "mt-10 border-l-2 px-4 py-3 font-mono",
            decision === "approved"
              ? "border-signal bg-signal/5 text-signal"
              : "border-border text-muted-foreground",
          )}
        >
          {decision === "approved"
            ? "Approved. Go back to your terminal."
            : "Denied. The terminal gets no key."}
        </p>
      ) : (
        <div className="mt-10 flex flex-col gap-4">
          <form onSubmit={fire(lookup)}>
            <Field label="Code" htmlFor="device-code">
              <div className="flex gap-2">
                <Input
                  id="device-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value.toUpperCase())}
                  placeholder="BCDF-GHJK"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-11 font-mono text-lg tracking-widest md:text-lg"
                />
                <Button type="submit" size="lg" disabled={checking || code.trim() === ""}>
                  {checking ? "Checking…" : "Check"}
                </Button>
              </div>
            </Field>
          </form>
          {info === null ? null : (
            <div className="flex flex-col gap-3">
              <Ledger>
                <LedgerRow term="client">{info.client_name}</LedgerRow>
                <LedgerRow term="status">{info.status}</LedgerRow>
              </Ledger>
              {info.status === "pending" ? (
                <div className="flex gap-2">
                  <Button onClick={fire(() => decide(true))}>Approve</Button>
                  <Button variant="outline" onClick={fire(() => decide(false))}>
                    Deny
                  </Button>
                </div>
              ) : null}
            </div>
          )}
          <ErrorNote error={error} />
        </div>
      )}
    </Page>
  );
}
