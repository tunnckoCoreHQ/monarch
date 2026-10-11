import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BookOpen, File, Folder, FolderGit2, History } from "lucide-react";
import { useMemo } from "react";

import { PathCrumbs, RefPicker, useRepo } from "~/components/repo";
import { Empty, Kicker, Page, Pending, Terminal } from "~/components/site";
import { Button } from "~/components/ui/button";
import { ago, api, bytes, type TreeItem } from "~/lib/api";
import { renderMarkdown } from "~/lib/markdown";

interface Search {
  ref?: string;
  path?: string;
}

// The link covers its whole row, so the row is the touch target.
const ROW_LINK =
  "hover:text-signal min-w-0 flex-1 truncate font-mono text-sm after:absolute after:inset-0";

export const Route = createFileRoute("/$owner/$repo/")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    ref: typeof search.ref === "string" ? search.ref : undefined,
    path: typeof search.path === "string" ? search.path : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps }) => {
    const base = `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
    const query = new URLSearchParams({ ref: deps.ref ?? "", path: deps.path ?? "" });
    try {
      const tree = await api<{ commit: string; items: TreeItem[]; readme?: string }>(
        `${base}/tree?${query.toString()}`,
      );
      const readme =
        tree.readme === undefined
          ? null
          : await api<{ text: string | null }>(
              `${base}/blob?${new URLSearchParams({ ref: tree.commit, path: tree.readme }).toString()}`,
            );
      const [latest] = await api<
        Array<{
          sha: string;
          message: string;
          author: { name: string };
          committer: { time: number };
        }>
      >(`${base}/commits?${new URLSearchParams({ ref: tree.commit, limit: "1" }).toString()}`);
      return {
        tree,
        readme: readme?.text ?? null,
        readmeName: tree.readme ?? null,
        latest: latest ?? null,
      };
    } catch {
      return { tree: null, readme: null, readmeName: null, latest: null };
    }
  },
  pendingComponent: () => <Pending label="Loading files" />,
  component: Code,
});

function EmptyRepo() {
  const repo = useRepo();
  if (repo.status === "importing" || repo.status === "forking") {
    return (
      <Page className="max-w-3xl">
        <Empty>
          Files show up here when the {repo.status === "importing" ? "import" : "fork"} finishes.
        </Empty>
      </Page>
    );
  }
  if (repo.role !== "write" && repo.role !== "admin") {
    return (
      <Page className="max-w-3xl">
        <Empty>Nothing pushed yet.</Empty>
      </Page>
    );
  }
  return (
    <Page className="flex max-w-3xl flex-col gap-6">
      <div>
        <Kicker>empty repository</Kicker>
        <h2 className="mt-3 text-3xl font-black tracking-tight md:text-4xl">
          Push the first commit.
        </h2>
        <p className="text-muted-foreground mt-3 max-w-xl">
          When git asks for a password, paste an API key from{" "}
          <Link to="/settings" className="text-signal underline underline-offset-4">
            settings
          </Link>
          . Or run <code className="text-foreground font-mono text-sm">wgw login</code> once.
        </p>
      </div>
      <Terminal title="push an existing repository">{`git remote add wgw ${repo.clone_url}
git push wgw main`}</Terminal>
      <Terminal title="or start fresh">{`git clone ${repo.clone_url}
cd ${repo.name} && echo "# ${repo.name}" > README.md
git add . && git commit -m "first commit" && git push`}</Terminal>
    </Page>
  );
}

function Code() {
  const repo = useRepo();
  const { tree, readme, readmeName, latest } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const ref = search.ref ?? repo.default_branch;
  const path = search.path ?? "";
  const html = useMemo(() => (readme === null ? "" : renderMarkdown(readme)), [readme]);

  if (repo.empty) {
    return <EmptyRepo />;
  }

  const segments = path === "" ? [] : path.split("/");
  const toolbar = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <RefPicker
        value={ref}
        branches={repo.branches}
        tags={repo.tags}
        onChange={(next) =>
          navigate({
            to: "/$owner/$repo",
            params: { owner: repo.owner, repo: repo.name },
            search: { ref: next, path: path || undefined },
          })
        }
      />
      <PathCrumbs owner={repo.owner} name={repo.name} refName={ref} path={path} />
    </div>
  );

  if (tree === null) {
    return (
      <Page className="flex flex-col gap-6">
        {toolbar}
        <Empty
          action={
            <Button asChild variant="outline">
              <Link to="/$owner/$repo" params={{ owner: repo.owner, repo: repo.name }}>
                Back to the repository root
              </Link>
            </Button>
          }
        >
          Nothing at {path === "" ? "the root" : path} on {ref}.
        </Empty>
      </Page>
    );
  }

  return (
    <Page className="flex flex-col gap-6">
      {toolbar}
      <div className="border">
        {latest === null ? null : (
          <div className="bg-card flex items-center gap-3 border-b px-4 py-2.5 text-sm">
            <span className="max-w-[40%] shrink-0 truncate font-semibold">
              {latest.author.name}
            </span>
            <Link
              to="/$owner/$repo/commit/$sha"
              params={{ owner: repo.owner, repo: repo.name, sha: latest.sha }}
              className="text-muted-foreground hover:text-foreground min-w-0 flex-1 truncate"
            >
              {latest.message.split("\n")[0]}
            </Link>
            <span className="text-faint hidden shrink-0 font-mono text-xs sm:inline">
              {ago(latest.committer.time)}
            </span>
            <Link
              to="/$owner/$repo/commit/$sha"
              params={{ owner: repo.owner, repo: repo.name, sha: latest.sha }}
              className="text-violet hidden shrink-0 font-mono text-xs hover:underline sm:inline"
            >
              {latest.sha.slice(0, 7)}
            </Link>
            <Link
              to="/$owner/$repo/commits"
              params={{ owner: repo.owner, repo: repo.name }}
              search={{ ref }}
              aria-label="Commit history"
              className="text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-1.5 font-mono text-xs"
            >
              <History className="size-3.5" />
              <span className="hidden sm:inline">History</span>
            </Link>
          </div>
        )}
        <ul className="divide-y">
          {path === "" ? null : (
            <li className="hover:bg-card relative px-4 py-2.5">
              <Link
                to="/$owner/$repo"
                params={{ owner: repo.owner, repo: repo.name }}
                search={{ ref, path: segments.slice(0, -1).join("/") || undefined }}
                aria-label="Parent folder"
                className="text-muted-foreground hover:text-foreground font-mono text-sm after:absolute after:inset-0"
              >
                ..
              </Link>
            </li>
          )}
          {tree.items.map((item) => (
            <li
              key={item.path}
              className="hover:bg-card relative flex items-center gap-3 px-4 py-2.5"
            >
              {item.type === "tree" ? <Folder className="text-signal size-4 shrink-0" /> : null}
              {item.type === "blob" ? <File className="text-faint size-4 shrink-0" /> : null}
              {item.type === "commit" ? (
                <FolderGit2 className="text-faint size-4 shrink-0" />
              ) : null}
              {item.type === "tree" ? (
                <Link
                  to="/$owner/$repo"
                  params={{ owner: repo.owner, repo: repo.name }}
                  search={{ ref, path: item.path }}
                  className={ROW_LINK}
                >
                  {item.name}
                </Link>
              ) : null}
              {item.type === "blob" ? (
                <Link
                  to="/$owner/$repo/blob"
                  params={{ owner: repo.owner, repo: repo.name }}
                  search={{ ref, path: item.path }}
                  className={ROW_LINK}
                >
                  {item.name}
                </Link>
              ) : null}
              {item.type === "commit" ? (
                <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-sm">
                  {item.name} <span className="text-faint text-xs">submodule</span>
                </span>
              ) : null}
              <span className="text-faint shrink-0 font-mono text-xs">{bytes(item.size)}</span>
            </li>
          ))}
        </ul>
      </div>
      {readme === null ? null : (
        <article className="min-w-0 border">
          <div className="bg-card text-muted-foreground flex items-center gap-2 border-b px-4 py-2 font-mono text-xs">
            <BookOpen className="size-3.5" />
            {readmeName}
          </div>
          {/* The renderer escapes raw HTML and drops unsafe link schemes. */}
          <div
            className="prose-md px-4 py-5 md:px-8 md:py-6"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </article>
      )}
    </Page>
  );
}
