import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

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

interface Claim {
  registration_id: string;
  type: string;
  status: string;
  claim_email: string;
  expired: boolean;
  scopes: string[];
}

export const Route = createFileRoute("/claim")({
  validateSearch: (search: Record<string, unknown>): { attempt?: string } => ({
    attempt: typeof search.attempt === "string" ? search.attempt : undefined,
  }),
  component: ClaimPage,
});

function ClaimPage() {
  const { attempt = "" } = Route.useSearch();
  const [claim, setClaim] = useState<Claim | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (attempt === "") {
      return;
    }
    api<Claim>(`/api/claims/${encodeURIComponent(attempt)}`)
      .then(setClaim)
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 401) {
          window.location.assign(
            `/login?return_to=${encodeURIComponent(`/claim?attempt=${attempt}`)}`,
          );
          return;
        }
        setError(messageOf(caught));
      });
  }, [attempt]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api(`/api/claims/${encodeURIComponent(attempt)}`, {
        method: "POST",
        json: { user_code: code },
      });
      setDone(true);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSubmitting(false);
    }
  };

  if (attempt === "") {
    return (
      <Page className="max-w-2xl py-16">
        <PageHeader kicker="auth.md claim" title="No claim in this link.">
          Open the exact link the agent gave you. It ends with an attempt code.
        </PageHeader>
      </Page>
    );
  }

  return (
    <Page className="max-w-2xl py-16">
      <PageHeader kicker="auth.md claim" title="An agent wants in.">
        Type the six-digit code the agent showed you. Only claim agents you started.
      </PageHeader>
      <div className="mt-10 flex flex-col gap-4">
        {claim === null && error === null ? (
          <p
            role="status"
            className="text-muted-foreground font-mono text-xs tracking-wider uppercase"
          >
            Loading the claim…
          </p>
        ) : null}
        {claim === null ? null : (
          <Ledger>
            <LedgerRow term="registration">{claim.registration_id}</LedgerRow>
            <LedgerRow term="for">{claim.claim_email}</LedgerRow>
            <LedgerRow term="scopes">{claim.scopes.join(", ")}</LedgerRow>
          </Ledger>
        )}
        {claim?.expired === true && !done ? (
          <ErrorNote error="This claim expired. Ask the agent to start a new one." />
        ) : null}
        {done ? (
          <p
            role="status"
            className="border-signal bg-signal/5 text-signal border-l-2 px-4 py-3 font-mono"
          >
            Claimed. The agent can now act as you with read and write access.
          </p>
        ) : (
          <form onSubmit={fire(submit)}>
            <Field label="Code" htmlFor="claim-code">
              <div className="flex gap-2">
                <Input
                  id="claim-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="123456"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  className="h-11 font-mono text-lg tracking-widest md:text-lg"
                />
                <Button
                  type="submit"
                  size="lg"
                  disabled={submitting || claim === null || claim.expired || code.length !== 6}
                >
                  {submitting ? "Claiming…" : "Claim"}
                </Button>
              </div>
            </Field>
          </form>
        )}
        <ErrorNote error={error} />
      </div>
    </Page>
  );
}
