import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";

import { DiffView } from "~/components/diff";
import { useRepo } from "~/components/repo";
import { ErrorNote, Field, Kicker, messageOf, Page, fire } from "~/components/site";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { Textarea } from "~/components/ui/textarea";
import { api, type Commit, type FileDiff } from "~/lib/api";
import { cn } from "~/lib/utils";

interface Compare {
  commits: Commit[];
  files: FileDiff[];
  mergeable: boolean;
  fastForward: boolean;
}

export const Route = createFileRoute("/$owner/$repo/pulls/new")({
  validateSearch: (search: Record<string, unknown>): { head?: string; base?: string } => ({
    head: typeof search.head === "string" ? search.head : undefined,
    base: typeof search.base === "string" ? search.base : undefined,
  }),
  component: NewPull,
});

function compareText(compare: Compare): string {
  const commits = compare.commits.length === 1 ? "1 commit" : `${compare.commits.length} commits`;
  if (!compare.mergeable) {
    return `${commits} · conflicts`;
  }
  return `${commits} · ${compare.fastForward ? "fast-forward" : "merges cleanly"}`;
}

function NewPull() {
  const repo = useRepo();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [base, setBase] = useState(search.base ?? repo.default_branch);
  const [head, setHead] = useState(
    search.head ?? repo.branches.find((branch) => branch !== repo.default_branch) ?? "",
  );
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [compare, setCompare] = useState<Compare | null>(null);
  const [comparing, setComparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (head === "" || head === base) {
      setCompare(null);
      return;
    }
    setComparing(true);
    api<Compare>(
      `/api/repos/${repo.owner}/${repo.name}/compare?${new URLSearchParams({ base, head }).toString()}`,
    )
      .then((result) => {
        setCompare(result);
        if (title === "" && result.commits.length > 0) {
          setTitle(result.commits.at(-1)!.message.split("\n")[0]);
        }
      })
      .catch((caught: unknown) => setError(messageOf(caught)))
      .finally(() => setComparing(false));
  }, [base, head]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const pull = await api<{ number: number }>(`/api/repos/${repo.owner}/${repo.name}/pulls`, {
        method: "POST",
        json: { title, body, head, base },
      });
      await navigate({
        to: "/$owner/$repo/pull/$number",
        params: { owner: repo.owner, repo: repo.name, number: String(pull.number) },
      });
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const branchOptions = repo.branches.map((branch) => <option key={branch}>{branch}</option>);
  const sameBranch = head === "" || head === base;

  return (
    <Page className="flex flex-col gap-8">
      <header>
        <Kicker>new pull request</Kicker>
        <h2 className="mt-3 text-3xl font-black tracking-tight md:text-4xl">
          Open a pull request.
        </h2>
        <p className="text-muted-foreground mt-3 max-w-xl">
          Pick the branch with your changes and the branch it lands in.
        </p>
      </header>
      <div className="bg-card flex flex-wrap items-end gap-x-3 gap-y-4 border p-4">
        <Field label="From" htmlFor="head" className="w-full sm:w-56">
          <NativeSelect
            id="head"
            value={head}
            onChange={(event) => setHead(event.target.value)}
            className="w-full"
          >
            {branchOptions}
          </NativeSelect>
        </Field>
        <ArrowRight aria-hidden className="text-faint mb-2.5 hidden size-4 sm:block" />
        <Field label="Into" htmlFor="base" className="w-full sm:w-56">
          <NativeSelect
            id="base"
            value={base}
            onChange={(event) => setBase(event.target.value)}
            className="w-full"
          >
            {branchOptions}
          </NativeSelect>
        </Field>
        <p
          role="status"
          className={cn(
            "font-mono text-xs sm:mb-2.5 sm:ml-auto",
            compare === null || comparing
              ? "text-muted-foreground"
              : compare.mergeable
                ? "text-signal"
                : "text-destructive",
          )}
        >
          {sameBranch ? "Pick two different branches." : null}
          {!sameBranch && comparing ? "Comparing…" : null}
          {!sameBranch && !comparing && compare !== null ? compareText(compare) : null}
        </p>
      </div>
      <form onSubmit={fire(submit)} className="flex max-w-3xl flex-col gap-5">
        <Field label="Title" htmlFor="title">
          <Input
            id="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="h-10 text-base"
          />
        </Field>
        <Field label="Description" htmlFor="body" hint="Markdown works.">
          <Textarea
            id="body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="What changed and why."
            rows={6}
          />
        </Field>
        <ErrorNote error={error} />
        <Button
          type="submit"
          size="lg"
          disabled={submitting || title === "" || sameBranch}
          className="self-start"
        >
          {submitting ? "Opening…" : "Open pull request"}
        </Button>
      </form>
      {compare === null ? null : <DiffView files={compare.files} />}
    </Page>
  );
}
