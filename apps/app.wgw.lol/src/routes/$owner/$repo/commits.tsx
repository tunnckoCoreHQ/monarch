import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { CommitList, RefPicker, useRepo } from "~/components/repo";
import { Empty, Page, Pending, RouteError } from "~/components/site";
import { api, ApiError, type Commit } from "~/lib/api";
import { pageTitle } from "~/lib/utils";

const LIMIT = 100;

export const Route = createFileRoute("/$owner/$repo/commits")({
  validateSearch: (search: Record<string, unknown>) => ({
    ref: typeof search.ref === "string" ? search.ref : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps }) => {
    try {
      return await api<Commit[]>(
        `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/commits?${new URLSearchParams({ ref: deps.ref ?? "", limit: String(LIMIT) }).toString()}`,
      );
    } catch (error) {
      // A default branch with nothing in this view has no history yet. A bad ref goes to the
      // error page.
      if (error instanceof ApiError && error.status === 404 && deps.ref === undefined) {
        return [];
      }
      throw error;
    }
  },
  head: ({ params }) => ({
    meta: [{ title: pageTitle("Commits", `${params.owner}/${params.repo}`) }],
  }),
  pendingComponent: () => <Pending label="Loading commits" />,
  errorComponent: ({ error }) => (
    <RouteError
      error={error}
      notFound={{ title: "No such revision.", text: "That branch, tag, or commit does not exist." }}
    />
  ),
  component: Commits,
});

function countLabel(count: number): string {
  if (count >= LIMIT) {
    return `Latest ${LIMIT} commits`;
  }
  return count === 1 ? "1 commit" : `${count} commits`;
}

function Commits() {
  const repo = useRepo();
  const commits = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const ref = search.ref ?? repo.default_branch;
  return (
    <Page className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RefPicker
          value={ref}
          branches={repo.branches}
          tags={repo.tags}
          onChange={(next) =>
            navigate({
              to: "/$owner/$repo/commits",
              params: { owner: repo.owner, repo: repo.name },
              search: { ref: next },
            })
          }
        />
        {commits.length === 0 ? null : (
          <p className="text-muted-foreground font-mono text-xs">{countLabel(commits.length)}</p>
        )}
      </div>
      {commits.length === 0 ? (
        <Empty>No commits on {ref} yet.</Empty>
      ) : (
        <CommitList commits={commits} owner={repo.owner} repo={repo.name} />
      )}
    </Page>
  );
}
