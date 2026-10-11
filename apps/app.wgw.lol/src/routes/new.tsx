import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorNote, Kicker, messageOf, Page, fire } from "~/components/site";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { api, type Repo } from "~/lib/api";

export const Route = createFileRoute("/new")({
  validateSearch: (search: Record<string, unknown>): { import?: string } => ({
    import: typeof search.import === "string" ? search.import : undefined,
  }),
  component: NewRepo,
});

function NewRepo() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [importUrl, setImportUrl] = useState(search.import ?? "");
  const [importBranch, setImportBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <Page className="max-w-2xl">
      <Kicker>new repository</Kicker>
      <h1 className="mt-2 text-5xl font-black tracking-tight">Make a repository.</h1>
      <form onSubmit={fire(submit)} className="mt-8 flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="my-project"
            className="font-mono"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="description">Description</Label>
          <Input
            id="description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <fieldset className="bg-border grid grid-cols-2 gap-px border">
          {(["public", "private"] as const).map((value) => (
            <label
              key={value}
              className={`bg-background cursor-pointer p-4 ${visibility === value ? "outline-signal outline-2 -outline-offset-2" : ""}`}
            >
              <input
                type="radio"
                name="visibility"
                className="sr-only"
                checked={visibility === value}
                onChange={() => setVisibility(value)}
              />
              <span className="block font-extrabold capitalize">{value}</span>
              <span className="text-muted-foreground mt-1 block text-xs">
                {value === "public"
                  ? "Anyone can read it. Paths in .gitprivate stay members-only."
                  : "Only you and collaborators can see it."}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="flex flex-col gap-2">
          <Label htmlFor="import">Import from a git remote (optional)</Label>
          <Input
            id="import"
            value={importUrl}
            onChange={(event) => guess(event.target.value)}
            placeholder="https://github.com/owner/repo"
            className="font-mono"
          />
          <p className="text-muted-foreground text-xs">
            Any public HTTPS git remote. Cloudflare Artifacts copies one branch, the remote&apos;s
            default unless you name another. The repository opens while the import runs.
          </p>
          {importUrl === "" ? null : (
            <Input
              id="import-branch"
              value={importBranch}
              onChange={(event) => setImportBranch(event.target.value)}
              placeholder="branch to import (optional)"
              className="font-mono"
            />
          )}
        </div>
        <ErrorNote error={error} />
        <Button type="submit" size="lg" disabled={busy}>
          {busy
            ? importUrl === ""
              ? "Creating…"
              : "Importing…"
            : importUrl === ""
              ? "Create repository"
              : "Import repository"}
        </Button>
      </form>
    </Page>
  );
}
