import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  ErrorNote,
  messageOf,
  Page,
  PageHeader,
  Pending,
  RouteError,
  fire,
} from "~/components/site";
import { Button } from "~/components/ui/button";
import { api } from "~/lib/api";

interface AuthState {
  level: "none" | "pending" | "full";
  user?: { handle: string; name: string };
  passkeys?: Array<{ id: string; name: string }>;
}

export const Route = createFileRoute("/login_/passkey")({
  validateSearch: (search: Record<string, unknown>): { return_to?: string } => ({
    return_to: typeof search.return_to === "string" ? search.return_to : undefined,
  }),
  loader: () => api<AuthState>("/api/auth/state"),
  pendingComponent: () => <Pending label="Checking sign-in" />,
  errorComponent: ({ error }) => <RouteError error={error} />,
  component: PasskeyStep,
});

function PasskeyStep() {
  const state = Route.useLoaderData();
  const { return_to = "/" } = Route.useSearch();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasPasskey = (state.passkeys?.length ?? 0) > 0;

  useEffect(() => {
    if (state.level === "full") {
      window.location.assign(return_to.startsWith("/") ? return_to : "/");
    }
  }, [state.level, return_to]);

  const finish = async () => {
    await router.invalidate();
    window.location.assign(return_to.startsWith("/") ? return_to : "/");
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (hasPasskey) {
        const optionsJSON = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
          "/api/auth/passkey/authenticate/options",
          { method: "POST" },
        );
        const response = await startAuthentication({ optionsJSON });
        await api("/api/auth/passkey/authenticate/verify", { method: "POST", json: { response } });
      } else {
        const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
          "/api/auth/passkey/register/options",
          { method: "POST" },
        );
        const response = await startRegistration({ optionsJSON });
        await api("/api/auth/passkey/register/verify", {
          method: "POST",
          json: { response, name: navigator.platform || "passkey" },
        });
      }
      await finish();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  if (state.level === "none") {
    return (
      <Page className="max-w-2xl py-16">
        <PageHeader kicker="step 2 of 2" title="Sign in first.">
          The passkey step comes after Google.
        </PageHeader>
        <Button asChild size="lg" className="mt-8">
          <a href="/login">Back to sign in</a>
        </Button>
      </Page>
    );
  }
  return (
    <Page className="max-w-2xl py-16">
      <PageHeader
        kicker="step 2 of 2"
        title={hasPasskey ? "Confirm with your passkey." : "Create your passkey."}
      >
        Google said you are <span className="text-foreground font-mono">@{state.user?.handle}</span>
        .{" "}
        {hasPasskey
          ? "Your passkey proves it is still you."
          : "This passkey is your second factor from now on. Use Touch ID, Windows Hello, a phone, or a security key."}
      </PageHeader>
      <div className="mt-8 flex flex-col gap-3 sm:items-start">
        <Button size="lg" disabled={busy} onClick={fire(run)}>
          {busy ? "Waiting for the passkey…" : hasPasskey ? "Use passkey" : "Create passkey"}
        </Button>
        <ErrorNote error={error} />
      </div>
    </Page>
  );
}
