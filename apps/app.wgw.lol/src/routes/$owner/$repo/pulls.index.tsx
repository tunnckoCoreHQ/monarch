import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";

import { useRepo } from "~/components/repo";
import { Empty, Page, Pending, RouteError } from "~/components/site";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ago, api } from "~/lib/api";
import { cn, pageTitle } from "~/lib/utils";

export interface Pull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: "open" | "closed" | "merged";
  merge_sha: string | null;
  summary: string | null;
  author: string;
  created_at: number;
  updated_at: number;
}

const FILTERS = ["open", "merged", "closed", "all"] as const;

const STATE_BADGE = { open: "signal", merged: "violet", closed: "outline" } as const;

export const Route = createFileRoute("/$owner/$repo/pulls/")({
  validateSearch: (search: Record<string, unknown>) => ({
    state:
      search.state === "closed" || search.state === "merged" || search.state === "all"
        ? search.state
        : "open",
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ params, deps }) =>
    api<Pull[]>(
      `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls?state=${deps.state}`,
    ),
  head: ({ params }) => ({
    meta: [{ title: pageTitle("Pull requests", `${params.owner}/${params.repo}`) }],
  }),
  pendingComponent: () => <Pending label="Loading pull requests" />,
  errorComponent: ({ error }) => <RouteError error={error} />,
  component: Pulls,
});

export function StateBadge({ state }: { state: Pull["state"] }) {
  return <Badge variant={STATE_BADGE[state]}>{state}</Badge>;
}

function Pulls() {
  const repo = useRepo();
  const pulls = Route.useLoaderData();
  const { state } = Route.useSearch();
  const canWrite = repo.role === "write" || repo.role === "admin";

  return (
    <Page className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Filter by state" className="flex divide-x border">
          {FILTERS.map((value) => (
            <Link
              key={value}
              to="/$owner/$repo/pulls"
              params={{ owner: repo.owner, repo: repo.name }}
              search={{ state: value }}
              aria-current={value === state ? "page" : undefined}
              className={cn(
                "flex h-8 items-center px-3 font-mono text-xs tracking-wider uppercase focus-visible:-outline-offset-2",
                value === state
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {value}
            </Link>
          ))}
        </nav>
        {canWrite ? (
          <Button asChild size="sm">
            <Link to="/$owner/$repo/pulls/new" params={{ owner: repo.owner, repo: repo.name }}>
              <Plus />
              New pull request
            </Link>
          </Button>
        ) : null}
      </div>
      {pulls.length === 0 ? (
        <Empty>No {state === "all" ? "" : `${state} `}pull requests.</Empty>
      ) : (
        <ul className="divide-y border">
          {pulls.map((pull) => (
            <li
              key={pull.number}
              className="hover:bg-card relative grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 px-4 py-3"
            >
              <StateBadge state={pull.state} />
              <Link
                to="/$owner/$repo/pull/$number"
                params={{ owner: repo.owner, repo: repo.name, number: String(pull.number) }}
                title={pull.title}
                className="hover:text-signal truncate font-semibold after:absolute after:inset-0"
              >
                {pull.title}
              </Link>
              <p className="text-muted-foreground col-start-2 font-mono text-xs wrap-anywhere">
                #{pull.number} · {pull.head} → {pull.base} · @{pull.author} · {ago(pull.created_at)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
