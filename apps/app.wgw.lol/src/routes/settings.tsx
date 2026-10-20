import { startRegistration } from "@simplewebauthn/browser";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useState } from "react";

import {
  CopyField,
  Empty,
  ErrorNote,
  Field,
  fire,
  messageOf,
  Page,
  PageHeader,
  Pending,
  RouteError,
  Section,
} from "~/components/site";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { api, ago } from "~/lib/api";
import { cn, pageTitle } from "~/lib/utils";

interface Key {
  id: string;
  name: string;
  kind: string;
  prefix: string;
  scopes: string[];
  repo_id: string | null;
  repo: string | null;
  environment: string | null;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
}

interface Agent {
  id: string;
  type: "anonymous" | "service_auth";
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
}

interface AuthState {
  level: string;
  user?: { handle: string; provider: string };
  passkeys?: Array<{ id: string; name: string; created_at: number; last_used_at: number | null }>;
}

export const Route = createFileRoute("/settings")({
  loader: async () => {
    const [keys, agents, state] = await Promise.all([
      api<Key[]>("/api/keys"),
      api<Agent[]>("/api/agents"),
      api<AuthState>("/api/auth/state"),
    ]);
    return { keys, agents, state };
  },
  head: () => ({ meta: [{ title: pageTitle("Settings") }] }),
  pendingComponent: () => <Pending label="Loading settings" />,
  errorComponent: ({ error }) => <RouteError error={error} />,
  component: Settings,
});

const SCOPES = ["read", "write", "admin", "secrets"];

/** Display names of the sign-in providers stored on each account. */
const PROVIDERS: Record<string, string> = {
  agentid: "AgentID",
  authmd: "auth.md",
  google: "Google",
  passkey: "Passkey",
};

function Settings() {
  const { keys, agents, state } = Route.useLoaderData();
  const router = useRouter();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read", "write"]);
  const [repo, setRepo] = useState("");
  const [environment, setEnvironment] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ id: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const result = await api<{ id: string; token: string }>("/api/keys", {
        method: "POST",
        json: {
          name: name || "api key",
          scopes,
          repo: repo || undefined,
          environment: environment || undefined,
        },
      });
      setCreated({ id: result.id, token: result.token });
      setName("");
      setScopes(["read", "write"]);
      setRepo("");
      setEnvironment("");
      await router.invalidate();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (key: Key) => {
    const question =
      key.kind === "agent"
        ? `Revoke ${key.name}? The agent loses access and cannot get new tokens.`
        : `Revoke ${key.name}? Anything that uses it stops working.`;
    if (!window.confirm(question)) {
      return;
    }
    try {
      await api(`/api/keys/${key.id}`, { method: "DELETE" });
      // A revoked key's plaintext must not stay on screen.
      setCreated((shown) => (shown?.id === key.id ? null : shown));
      await router.invalidate();
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  const revokeAgent = async (agent: Agent) => {
    if (!window.confirm(`Revoke agent ${agent.id}? It loses access and cannot get new tokens.`)) {
      return;
    }
    try {
      await api(`/api/agents/${agent.id}`, { method: "DELETE" });
      await router.invalidate();
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  const addPasskey = async () => {
    setError(null);
    try {
      const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
        "/api/auth/passkey/register/options",
        { method: "POST" },
      );
      const response = await startRegistration({ optionsJSON });
      await api("/api/auth/passkey/register/verify", {
        method: "POST",
        json: { response, name: `passkey ${(state.passkeys?.length ?? 0) + 1}` },
      });
      await router.invalidate();
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  const removePasskey = async (id: string) => {
    try {
      await api(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
      await router.invalidate();
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  const toggleScope = (scope: string, checked: boolean) =>
    setScopes(checked ? [...scopes, scope] : scopes.filter((item) => item !== scope));
  const passkeys = state.passkeys ?? [];
  const provider = state.user?.provider ?? "";

  return (
    <Page className="flex max-w-4xl flex-col gap-14">
      <PageHeader kicker="settings" title={`@${state.user?.handle ?? ""}`}>
        Signed in with {PROVIDERS[provider] ?? provider}.
      </PageHeader>
      <ErrorNote error={error} />

      <Section
        title="API keys"
        description="Use a key as a bearer token or as the git password. For agents, limit it to one repository and one environment."
      >
        <form onSubmit={fire(create)} className="bg-card grid gap-5 border p-4 md:grid-cols-3">
          <Field label="Name" htmlFor="key-name">
            <Input
              id="key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="deploy-bot"
            />
          </Field>
          <Field label="Repository" htmlFor="key-repo" hint="Optional.">
            <Input
              id="key-repo"
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              placeholder="owner/repo"
              className="font-mono"
            />
          </Field>
          <Field label="Environment" htmlFor="key-environment" hint="Optional.">
            <Input
              id="key-environment"
              value={environment}
              onChange={(event) => setEnvironment(event.target.value)}
              placeholder="production"
              className="font-mono"
            />
          </Field>
          <fieldset className="md:col-span-3">
            <legend className="text-muted-foreground mb-2 font-mono text-xs tracking-wider uppercase">
              Scopes
            </legend>
            <div className="flex flex-wrap gap-2">
              {SCOPES.map((scope) => {
                const checked = scopes.includes(scope);
                return (
                  <label
                    key={scope}
                    className={cn(
                      "has-[input:focus-visible]:outline-ring flex h-8 cursor-pointer items-center gap-1.5 border px-3 font-mono text-xs has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2",
                      checked
                        ? "border-signal text-signal"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      onChange={(event) => toggleScope(scope, event.target.checked)}
                    />
                    {checked ? <Check aria-hidden className="size-3.5" /> : null}
                    {scope}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3 md:col-span-3">
            <Button type="submit" disabled={creating || scopes.length === 0}>
              {creating ? "Creating…" : "Create key"}
            </Button>
            {scopes.length === 0 ? (
              <p className="text-muted-foreground text-xs">Pick at least one scope.</p>
            ) : null}
          </div>
        </form>
        {created === null ? null : (
          <div
            role="status"
            className="border-signal bg-signal/5 flex flex-col gap-3 border-l-2 p-4"
          >
            <p className="text-sm font-bold">Copy the key now. This page shows it once.</p>
            <CopyField label="key" value={created.token} />
          </div>
        )}
        {keys.length === 0 ? (
          <Empty>No keys yet.</Empty>
        ) : (
          <ul className="divide-y border">
            {keys.map((key) => (
              <li key={key.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <span className="font-semibold wrap-anywhere">{key.name}</span>
                <code className="text-muted-foreground font-mono text-xs">{key.prefix}…</code>
                <span className="flex flex-wrap gap-1.5">
                  {key.kind === "agent" ? <Badge variant="violet">agent</Badge> : null}
                  {key.scopes.map((scope) => (
                    <Badge key={scope} variant="outline">
                      {scope}
                    </Badge>
                  ))}
                  {key.repo_id === null ? null : (
                    <Badge variant="outline">repo:{key.repo ?? "deleted"}</Badge>
                  )}
                  {key.environment === null ? null : (
                    <Badge variant="outline">env:{key.environment}</Badge>
                  )}
                </span>
                <span className="text-faint ml-auto font-mono text-xs">
                  used {ago(key.last_used_at)}
                </span>
                <Button size="xs" variant="ghost" onClick={fire(() => revoke(key))}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Agents"
        description="auth.md agents you claimed. Each one acts as you with read and write access until you revoke it."
      >
        {agents.length === 0 ? (
          <Empty>No claimed agents.</Empty>
        ) : (
          <ul className="divide-y border">
            {agents.map((agent) => (
              <li key={agent.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <code className="font-mono text-sm wrap-anywhere">{agent.id}</code>
                <Badge variant="violet">{agent.type}</Badge>
                <span className="text-faint ml-auto font-mono text-xs">
                  used {ago(agent.last_used_at)}
                </span>
                <Button size="xs" variant="ghost" onClick={fire(() => revokeAgent(agent))}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Passkeys"
        description="Google accounts confirm every sign-in with one of these."
      >
        {passkeys.length === 0 ? (
          <Empty>No passkeys yet.</Empty>
        ) : (
          <ul className="divide-y border">
            {passkeys.map((key) => (
              <li key={key.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="font-semibold wrap-anywhere">{key.name}</span>
                <span className="text-faint ml-auto font-mono text-xs">
                  used {ago(key.last_used_at)}
                </span>
                <Button size="xs" variant="ghost" onClick={fire(() => removePasskey(key.id))}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button variant="outline" className="self-start" onClick={fire(addPasskey)}>
          Add a passkey
        </Button>
      </Section>
    </Page>
  );
}
