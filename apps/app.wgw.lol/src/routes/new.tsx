import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorNote, Field, messageOf, Page, PageHeader, fire, useMe } from "~/components/site";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { api, type Repo } from "~/lib/api";
import { cn } from "~/lib/utils";

const VISIBILITY = {
  public: "Anyone can read it. Paths in .gitprivate stay members-only.",
  private: "Only you and collaborators can see it.",
} as const;

export const Route = createFileRoute("/new")({
  validateSearch: (search: Record<string, unknown>): { import?: string } => ({
    import: typeof search.import === "string" ? search.import : undefined,
  }),
  component: NewRepo,
});

function NewRepo() {
  const me = useMe();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [importUrl, setImportUrl] = useState(search.import ?? "");
  const [importBranch, setImportBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (me === null) {
    return (
      <Page className="max-w-2xl py-16">
        <PageHeader kicker="new repository" title="Sign in first.">
          A repository belongs to an account. Sign in, then come back here.
        </PageHeader>
        <Button asChild size="lg" className="mt-8">
          <a href={`/login?return_to=${encodeURIComponent("/new")}`}>Sign in</a>
        </Button>
      </Page>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const repo = await api<Repo>("/api/repos", {
        method: "POST",
        json: {
          name,
          description,
          visibility,
          import_url: importUrl || undefined,
          import_branch: importBranch || undefined,
        },
      });
      await navigate({ to: "/$owner/$repo", params: { owner: repo.owner, repo: repo.name } });
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const guess = (url: string) => {
    setImportUrl(url);
    const last = url
      .replace(/\.git$/, "")
      .split("/")
      .findLast(Boolean);
    if (name === "" && last !== undefined && url.startsWith("https:")) {
      setName(last);
    }
  };

  const importing = importUrl !== "";
  const idleLabel = importing ? "Import repository" : "Create repository";

  return (
    <Page className="max-w-2xl">
      <PageHeader kicker="new repository" title="Make a repository." />
      <form onSubmit={fire(submit)} className="mt-10 flex flex-col gap-7">
        <Field label="Name" htmlFor="name">
          <div className="flex min-w-0">
            <span className="border-input bg-secondary text-muted-foreground flex max-w-[45%] shrink-0 items-center border border-r-0 px-3 font-mono text-sm">
              <span className="truncate">{me.handle}</span>/
            </span>
            <Input
              id="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="my-project"
              className="font-mono"
            />
          </div>
        </Field>
        <Field label="Description" htmlFor="description" hint="Optional. One line.">
          <Input
            id="description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-muted-foreground mb-2 font-mono text-xs tracking-wider uppercase">
            Visibility
          </legend>
          <div className="bg-border grid gap-px border sm:grid-cols-2">
            {(["public", "private"] as const).map((value) => (
              <label
                key={value}
                className={cn(
                  "has-[input:focus-visible]:outline-ring flex cursor-pointer items-start gap-3 p-4 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:-outline-offset-4",
                  visibility === value
                    ? "bg-card shadow-[inset_0_0_0_2px_var(--signal)]"
                    : "bg-background hover:bg-card",
                )}
              >
                <input
                  type="radio"
                  name="visibility"
                  className="sr-only"
                  checked={visibility === value}
                  onChange={() => setVisibility(value)}
                />
                <span
                  aria-hidden
                  className={cn(
                    "mt-1 size-3 shrink-0 border",
                    visibility === value ? "border-signal bg-signal" : "border-input",
                  )}
                />
                <span>
                  <span className="block font-extrabold capitalize">{value}</span>
                  <span className="text-muted-foreground mt-1 block text-xs">
                    {VISIBILITY[value]}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field
          label="Import from a git remote"
          htmlFor="import"
          hint="Optional. Any public HTTPS git remote. Cloudflare Artifacts copies one branch, the remote's default unless you name another. The repository opens while the import runs."
        >
          <Input
            id="import"
            value={importUrl}
            onChange={(event) => guess(event.target.value)}
            placeholder="https://github.com/owner/repo"
            className="font-mono"
          />
        </Field>
        {importing ? (
          <Field label="Branch to import" htmlFor="import-branch">
            <Input
              id="import-branch"
              value={importBranch}
              onChange={(event) => setImportBranch(event.target.value)}
              placeholder="the remote's default branch"
              className="font-mono"
            />
          </Field>
        ) : null}
        <ErrorNote error={error} />
        <Button type="submit" size="lg" disabled={busy} className="w-full sm:w-auto sm:self-start">
          {busy ? (importing ? "Importing…" : "Creating…") : idleLabel}
        </Button>
      </form>
    </Page>
  );
}
