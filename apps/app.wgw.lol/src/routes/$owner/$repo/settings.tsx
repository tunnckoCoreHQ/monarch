import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";

import { useRepo } from "~/components/repo";
import {
  Empty,
  ErrorNote,
  Field,
  messageOf,
  Page,
  Pending,
  RouteError,
  Section,
  Terminal,
} from "~/components/site";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { api } from "~/lib/api";

interface Variable {
  name: string;
  secret: boolean;
  value: string | null;
  updated_at: number;
}

interface Environments {
  repository: Variable[];
  environments: Array<{ name: string; kind: string; variables: Variable[] }>;
}

interface Collaborator {
  handle: string;
  role: string;
  kind?: string;
}

const ENVIRONMENT_KINDS = ["production", "staging", "preview", "development"];
const ROLES = ["read", "write", "admin"];

export const Route = createFileRoute("/$owner/$repo/settings")({
  loader: async ({ params }) => {
    const base = `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
    const [environments, collaborators] = await Promise.all([
      api<Environments>(`${base}/environments`),
      api<Collaborator[]>(`${base}/collaborators`),
    ]);
    return { environments, collaborators };
  },
  pendingComponent: () => <Pending label="Loading settings" />,
  errorComponent: ({ error }) => <RouteError error={error} />,
  component: RepoSettings,
});

/** A bordered group with a header strip, for one scope of values or one form. */
function Panel({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 border">
      <div className="bg-card flex flex-wrap items-center gap-2 border-b px-4 py-2 font-mono text-xs">
        {header}
      </div>
      {children}
    </div>
  );
}

function VariableTable({
  variables,
  onDelete,
}: {
  variables: Variable[];
  onDelete: ((name: string) => void) | null;
}) {
  if (variables.length === 0) {
    return <p className="text-faint px-4 py-3 font-mono text-xs">No values yet.</p>;
  }
  return (
    <ul className="divide-y">
      {variables.map((variable) => (
        <li
          key={variable.name}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 font-mono text-sm"
        >
          {variable.secret ? (
            <Lock aria-label="secret" className="text-signal size-3.5 shrink-0" />
          ) : (
            <span className="size-3.5 shrink-0" />
          )}
          <span className="font-semibold wrap-anywhere">{variable.name}</span>
          <span className="text-muted-foreground min-w-0 flex-1 truncate">
            {variable.secret ? "••••••••" : variable.value}
          </span>
          {onDelete === null ? null : (
            <Button size="xs" variant="ghost" onClick={() => onDelete(variable.name)}>
              Delete
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function RepoSettings() {
  const repo = useRepo();
  const { environments, collaborators } = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();
  const base = `/api/repos/${repo.owner}/${repo.name}`;
  const isAdmin = repo.role === "admin";
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState(repo.description);
  const [envName, setEnvName] = useState("");
  const [envKind, setEnvKind] = useState("production");
  const [varEnv, setVarEnv] = useState("");
  const [varName, setVarName] = useState("");
  const [varValue, setVarValue] = useState("");
  const [varSecret, setVarSecret] = useState(true);
  const [collaborator, setCollaborator] = useState("");
  const [role, setRole] = useState("write");

  // Event handlers get a plain function; the request runs in the background and reports errors.
  const act = (run: () => Promise<unknown>) => {
    setError(null);
    run()
      .then(() => router.invalidate())
      .catch((caught: unknown) => setError(messageOf(caught)));
  };

  // Forms submit through `act`, so Enter in a field does the same as the button.
  const onSubmit = (run: () => Promise<unknown>) => (event: FormEvent) => {
    event.preventDefault();
    act(run);
  };

  return (
    <Page className="flex max-w-4xl flex-col gap-14">
      {isAdmin ? null : (
        <p className="text-muted-foreground border-l-2 px-4 py-2 font-mono text-xs">
          Only admins can change these settings. You can read them.
        </p>
      )}
      <ErrorNote error={error} />

      <Section title="General">
        <form
          onSubmit={onSubmit(() => api(base, { method: "PATCH", json: { description } }))}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <Field label="Description" htmlFor="description" className="flex-1">
            <Input
              id="description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="One line about the repository"
              disabled={!isAdmin}
            />
          </Field>
          <Button type="submit" disabled={!isAdmin || description === repo.description}>
            Save
          </Button>
        </form>
        <div className="flex flex-wrap items-center justify-between gap-3 border px-4 py-3">
          <div>
            <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
              Visibility
            </p>
            <p className="mt-1 font-bold">
              {repo.visibility === "public"
                ? "Public. Anyone can read it."
                : "Private. Only members can see it."}
            </p>
          </div>
          <Button
            variant="outline"
            disabled={!isAdmin}
            onClick={() =>
              act(() =>
                api(base, {
                  method: "PATCH",
                  json: { visibility: repo.visibility === "public" ? "private" : "public" },
                }),
              )
            }
          >
            Make {repo.visibility === "public" ? "private" : "public"}
          </Button>
        </div>
      </Section>

      <Section
        title="Private paths"
        description={
          <>
            List paths in a <code className="text-foreground font-mono">.gitprivate</code> file at
            the root, gitignore style. Members see everything. Everyone else, on the web and over
            git, sees a history where those paths never existed. Each commit uses its own rules, so
            deleting a line publishes the path from that commit on, and earlier public hashes never
            change. Commits that only touch private paths are left out of the public history.
          </>
        }
      >
        <Terminal title=".gitprivate at the default branch">
          {repo.private_rules === null || repo.private_rules === ""
            ? "# no rules yet, for example:\nsecurity/\n*.pem\ndocs/embargoed-*.md"
            : repo.private_rules}
        </Terminal>
      </Section>

      <Section
        title="Environments and secrets"
        description={
          <>
            Repository values apply to every environment. Environment values override them. Agents
            pull them with a key that has the secrets scope:{" "}
            <code className="text-foreground font-mono">wgw env pull production</code>.
          </>
        }
      >
        <Panel
          header={
            <>
              <span className="font-bold">repository</span>
              <Badge variant="outline">all environments</Badge>
            </>
          }
        >
          <VariableTable
            variables={environments.repository}
            onDelete={
              isAdmin
                ? (name) => act(() => api(`${base}/variables/${name}`, { method: "DELETE" }))
                : null
            }
          />
        </Panel>
        {environments.environments.map((env) => (
          <Panel
            key={env.name}
            header={
              <>
                <span className="font-bold wrap-anywhere">{env.name}</span>
                <Badge variant="outline">{env.kind}</Badge>
                {isAdmin ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() =>
                      act(() => api(`${base}/environments/${env.name}`, { method: "DELETE" }))
                    }
                  >
                    Delete environment
                  </Button>
                ) : null}
              </>
            }
          >
            <VariableTable
              variables={env.variables}
              onDelete={
                isAdmin
                  ? (name) =>
                      act(() =>
                        api(
                          `${base}/variables/${name}?environment=${encodeURIComponent(env.name)}`,
                          { method: "DELETE" },
                        ),
                      )
                  : null
              }
            />
          </Panel>
        ))}
        {isAdmin ? (
          <>
            <Panel header={<span className="text-muted-foreground">Add an environment</span>}>
              <form
                onSubmit={onSubmit(async () => {
                  await api(`${base}/environments`, {
                    method: "POST",
                    json: { name: envName, kind: envKind },
                  });
                  setEnvName("");
                })}
                className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end"
              >
                <Field label="Name" htmlFor="env-name">
                  <Input
                    id="env-name"
                    value={envName}
                    onChange={(event) => setEnvName(event.target.value)}
                    placeholder="production"
                    className="font-mono"
                  />
                </Field>
                <Field label="Kind" htmlFor="env-kind">
                  <NativeSelect
                    id="env-kind"
                    value={envKind}
                    onChange={(event) => setEnvKind(event.target.value)}
                    className="w-full"
                  >
                    {ENVIRONMENT_KINDS.map((kind) => (
                      <option key={kind}>{kind}</option>
                    ))}
                  </NativeSelect>
                </Field>
                <Button type="submit" disabled={envName.trim() === ""}>
                  Add environment
                </Button>
              </form>
            </Panel>
            <Panel header={<span className="text-muted-foreground">Set a value</span>}>
              <form
                onSubmit={onSubmit(async () => {
                  await api(`${base}/variables/${varName}`, {
                    method: "PUT",
                    json: { value: varValue, secret: varSecret, environment: varEnv },
                  });
                  setVarName("");
                  setVarValue("");
                })}
                className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)_auto_auto] lg:items-end"
              >
                <Field label="Scope" htmlFor="var-env">
                  <NativeSelect
                    id="var-env"
                    value={varEnv}
                    onChange={(event) => setVarEnv(event.target.value)}
                    className="w-full"
                  >
                    <option value="">repository</option>
                    {environments.environments.map((env) => (
                      <option key={env.name} value={env.name}>
                        {env.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="Name" htmlFor="var-name">
                  <Input
                    id="var-name"
                    value={varName}
                    onChange={(event) => setVarName(event.target.value)}
                    placeholder="API_URL"
                    className="font-mono"
                  />
                </Field>
                <Field label="Value" htmlFor="var-value">
                  <Input
                    id="var-value"
                    value={varValue}
                    onChange={(event) => setVarValue(event.target.value)}
                    type={varSecret ? "password" : "text"}
                    className="font-mono"
                  />
                </Field>
                <label className="flex h-9 cursor-pointer items-center gap-2 font-mono text-xs tracking-wider uppercase">
                  <input
                    type="checkbox"
                    checked={varSecret}
                    onChange={(event) => setVarSecret(event.target.checked)}
                    className="accent-signal size-4"
                  />
                  Secret
                </label>
                <Button type="submit" disabled={varName.trim() === ""}>
                  Save value
                </Button>
              </form>
            </Panel>
          </>
        ) : null}
      </Section>

      <Section title="Collaborators">
        {collaborators.length === 0 ? (
          <Empty>No collaborators yet.</Empty>
        ) : (
          <ul className="divide-y border">
            {collaborators.map((item) => (
              <li
                key={item.handle}
                className="flex flex-wrap items-center gap-3 px-4 py-2.5 font-mono text-sm"
              >
                <span className="wrap-anywhere">@{item.handle}</span>
                {item.kind === "agent" ? <Badge variant="violet">agent</Badge> : null}
                <Badge variant="outline">{item.role}</Badge>
                {item.role === "owner" || !isAdmin ? null : (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() =>
                      act(() => api(`${base}/collaborators/${item.handle}`, { method: "DELETE" }))
                    }
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {isAdmin ? (
          <form
            onSubmit={onSubmit(async () => {
              await api(`${base}/collaborators/${collaborator}`, {
                method: "PUT",
                json: { role },
              });
              setCollaborator("");
            })}
            className="bg-card grid gap-3 border p-4 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end"
          >
            <Field label="Handle" htmlFor="collaborator">
              <Input
                id="collaborator"
                value={collaborator}
                onChange={(event) => setCollaborator(event.target.value.replace(/^@/, ""))}
                placeholder="a person or an agent"
                className="font-mono"
              />
            </Field>
            <Field label="Role" htmlFor="collaborator-role">
              <NativeSelect
                id="collaborator-role"
                value={role}
                onChange={(event) => setRole(event.target.value)}
                className="w-full"
              >
                {ROLES.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </NativeSelect>
            </Field>
            <Button type="submit" disabled={collaborator.trim() === ""}>
              Add collaborator
            </Button>
          </form>
        ) : null}
      </Section>

      {isAdmin ? (
        <section className="border-destructive flex flex-col gap-4 border p-5">
          <div>
            <h2 className="text-destructive text-2xl font-black tracking-tight">
              Delete repository
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Deletes both Artifacts repositories, the mirror, pull requests, environments, and
              secrets. There is no undo.
            </p>
          </div>
          <Button
            variant="destructive"
            className="self-start"
            onClick={() =>
              act(async () => {
                if (window.prompt(`Type ${repo.name} to delete it`) !== repo.name) {
                  return;
                }
                await api(base, { method: "DELETE" });
                await navigate({ to: "/$owner", params: { owner: repo.owner } });
              })
            }
          >
            Delete {repo.full_name}
          </Button>
        </section>
      ) : null}
    </Page>
  );
}
