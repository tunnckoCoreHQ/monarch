import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { DiffView } from "~/components/diff";
import { CommitList, useRepo } from "~/components/repo";
import {
  CopyField,
  Count,
  Empty,
  ErrorNote,
  messageOf,
  Page,
  Pending,
  RouteError,
  useMe,
} from "~/components/site";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import { ago, api, type Commit, type FileDiff } from "~/lib/api";
import { renderMarkdown } from "~/lib/markdown";
import { cn } from "~/lib/utils";

import { type Pull, StateBadge } from "./pulls.index";

interface PullDetail extends Pull {
  /** Only `error` is set when a branch of the pull request is gone. */
  compare: {
    commits?: Commit[];
    files?: FileDiff[];
    mergeable?: boolean;
    fastForward?: boolean;
    error?: string;
  } | null;
}

interface Comment {
  id: string;
  body: string;
  author: string;
  author_kind: string;
  created_at: number;
}

type Action = "merge" | "summary" | "close" | "reopen" | "comment";

export const Route = createFileRoute("/$owner/$repo/pull/$number")({
  loader: async ({ params }) => {
    const base = `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${params.number}`;
    const [pull, comments] = await Promise.all([
      api<PullDetail>(base),
      api<Comment[]>(`${base}/comments`),
    ]);
    return { pull, comments };
  },
  pendingComponent: () => <Pending label="Loading pull request" />,
  errorComponent: ({ error }) => (
    <RouteError
      error={error}
      notFound={{
        title: "No such pull request.",
        text: "This repository has no pull request with that number.",
      }}
    />
  ),
  component: PullView,
});

function Markdown({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  // The renderer escapes raw HTML and drops unsafe link schemes.
  return <div className="prose-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** One entry of the conversation: a header strip over a body. */
function Entry({
  header,
  children,
  violet = false,
}: {
  header: ReactNode;
  children: ReactNode;
  violet?: boolean;
}) {
  return (
    <article className={cn("min-w-0 border", violet && "border-violet/60")}>
      <header
        className={cn(
          "bg-card text-muted-foreground flex flex-wrap items-center gap-x-2 border-b px-4 py-2 font-mono text-xs",
          violet && "border-violet/60 bg-violet/10 text-violet",
        )}
      >
        {header}
      </header>
      <div className="px-4 py-3">{children}</div>
    </article>
  );
}

function Branch({ name }: { name: string }) {
  return <span className="bg-secondary text-foreground px-1.5 py-0.5 wrap-anywhere">{name}</span>;
}

function mergeStatus(compare: PullDetail["compare"]): { text: string; ok: boolean } {
  if (compare?.error !== undefined) {
    return { text: compare.error, ok: false };
  }
  if (compare?.mergeable !== true) {
    return { text: "Conflicts. Rebase or merge the base branch locally, then push.", ok: false };
  }
  return compare.fastForward
    ? { text: "Fast-forward merge is possible.", ok: true }
    : { text: "No conflicts. A merge commit will be created.", ok: true };
}

function PullView() {
  const repo = useRepo();
  const me = useMe();
  const { pull, comments } = Route.useLoaderData();
  const router = useRouter();
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const busy = pending !== null;
  const base = `/api/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`;
  const canWrite = repo.role === "write" || repo.role === "admin";
  const canComment = repo.role !== null || repo.visibility !== "private";
  const commits = pull.compare?.commits ?? [];
  const files = pull.compare?.files ?? [];
  const status = mergeStatus(pull.compare);

  // Event handlers get a plain function; the request runs in the background and reports errors.
  const act = (action: Action, run: () => Promise<unknown>) => {
    setPending(action);
    setError(null);
    run()
      .then(() => router.invalidate())
      .finally(() => setPending(null))
      .catch((caught: unknown) => setError(messageOf(caught)));
  };

  return (
    <Page className="flex flex-col gap-8">
      <header className="min-w-0">
        <div className="flex items-center gap-3">
          <StateBadge state={pull.state} />
          <span className="text-muted-foreground font-mono text-xs">#{pull.number}</span>
        </div>
        <h2 className="mt-3 text-3xl leading-tight font-black tracking-tight text-balance wrap-anywhere md:text-4xl">
          {pull.title}
        </h2>
        <p className="text-muted-foreground mt-3 font-mono text-xs leading-6">
          {pull.state === "merged" ? "Merged " : `@${pull.author} wants to merge `}
          <Branch name={pull.head} /> into <Branch name={pull.base} />
          {pull.merge_sha === null ? null : (
            <>
              {" as "}
              <Link
                to="/$owner/$repo/commit/$sha"
                params={{ owner: repo.owner, repo: repo.name, sha: pull.merge_sha }}
                className="text-violet hover:underline"
              >
                {pull.merge_sha.slice(0, 7)}
              </Link>
            </>
          )}
          {pull.state === "merged" ? ` · opened by @${pull.author}` : null} · {ago(pull.created_at)}
        </p>
      </header>
      <ErrorNote error={error} />
      <Tabs defaultValue="conversation" className="gap-6">
        <TabsList variant="line">
          <TabsTrigger value="conversation">
            Conversation <Count value={comments.length} />
          </TabsTrigger>
          <TabsTrigger value="commits">
            Commits <Count value={commits.length} />
          </TabsTrigger>
          <TabsTrigger value="files">
            Files <Count value={files.length} />
          </TabsTrigger>
        </TabsList>
        <TabsContent
          value="conversation"
          className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]"
        >
          <div className="flex min-w-0 flex-col gap-4">
            <Entry
              header={
                <>
                  <span className="text-foreground">@{pull.author}</span> opened this ·{" "}
                  {ago(pull.created_at)}
                </>
              }
            >
              {pull.body.trim() === "" ? (
                <p className="text-muted-foreground text-sm">No description.</p>
              ) : (
                <Markdown source={pull.body} />
              )}
            </Entry>
            {pull.summary === null ? null : (
              <Entry
                violet
                header={
                  <>
                    <Sparkles className="size-3.5" /> Workers AI summary
                  </>
                }
              >
                <Markdown source={pull.summary} />
              </Entry>
            )}
            {comments.map((item) => (
              <Entry
                key={item.id}
                header={
                  <>
                    <span className="text-foreground">@{item.author}</span>
                    {item.author_kind === "agent" ? (
                      <span className="text-violet">agent</span>
                    ) : null}
                    <span>· {ago(item.created_at)}</span>
                  </>
                }
              >
                <Markdown source={item.body} />
              </Entry>
            ))}
            {canComment && me === null ? (
              <p className="text-muted-foreground border border-dashed px-4 py-3 text-sm">
                <a
                  href={`/login?return_to=${encodeURIComponent(`/${repo.owner}/${repo.name}/pull/${pull.number}`)}`}
                  className="text-signal underline underline-offset-4"
                >
                  Sign in
                </a>{" "}
                to comment.
              </p>
            ) : null}
            {canComment && me !== null ? (
              <form
                className="flex flex-col gap-3 border p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  act("comment", async () => {
                    await api(`${base}/comments`, { method: "POST", json: { body: comment } });
                    setComment("");
                  });
                }}
              >
                <Label htmlFor="comment">Add a comment</Label>
                <Textarea
                  id="comment"
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="Markdown works."
                  rows={4}
                />
                <Button type="submit" className="self-end" disabled={busy || comment.trim() === ""}>
                  {pending === "comment" ? "Posting…" : "Comment"}
                </Button>
              </form>
            ) : null}
          </div>
          <aside className="flex min-w-0 flex-col gap-4">
            {pull.state === "open" && canWrite ? (
              <section
                aria-label="Merge"
                className={cn(
                  "border border-l-2",
                  status.ok ? "border-l-signal" : "border-l-destructive",
                )}
              >
                <p
                  className={cn(
                    "px-4 py-3 font-mono text-sm wrap-anywhere",
                    status.ok ? "text-signal" : "text-destructive",
                  )}
                >
                  {status.text}
                </p>
                <div className="flex flex-col gap-2 border-t p-4">
                  <Button
                    disabled={busy || pull.compare?.mergeable !== true}
                    onClick={() =>
                      act("merge", () => api(`${base}/merge`, { method: "POST", json: {} }))
                    }
                  >
                    {pending === "merge" ? "Merging…" : "Merge pull request"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => act("summary", () => api(`${base}/summary`, { method: "POST" }))}
                  >
                    <Sparkles />
                    {pending === "summary" ? "Summarizing…" : "Summarize with AI"}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      act("close", () => api(base, { method: "PATCH", json: { state: "closed" } }))
                    }
                  >
                    {pending === "close" ? "Closing…" : "Close pull request"}
                  </Button>
                </div>
              </section>
            ) : null}
            {pull.state === "closed" && canWrite ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  act("reopen", () => api(base, { method: "PATCH", json: { state: "open" } }))
                }
              >
                {pending === "reopen" ? "Reopening…" : "Reopen pull request"}
              </Button>
            ) : null}
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
                Diff for agents
              </p>
              <CopyField value={`curl -s ${window.location.origin}${base}/diff`} />
            </div>
          </aside>
        </TabsContent>
        <TabsContent value="commits">
          {commits.length === 0 ? (
            <Empty>No commits to show.</Empty>
          ) : (
            <CommitList commits={commits} owner={repo.owner} repo={repo.name} />
          )}
        </TabsContent>
        <TabsContent value="files">
          <DiffView files={files} />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
