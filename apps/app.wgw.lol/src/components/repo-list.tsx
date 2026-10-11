import { Link } from "@tanstack/react-router";
import { GitFork, Lock } from "lucide-react";
import type { ReactNode } from "react";

import { Empty } from "~/components/site";
import { ago, type Repo } from "~/lib/api";

export function RepoList({
  repos,
  empty,
  emptyAction,
}: {
  repos: Repo[];
  empty: string;
  emptyAction?: ReactNode;
}) {
  if (repos.length === 0) {
    return <Empty action={emptyAction}>{empty}</Empty>;
  }
  return (
    <ul className="divide-y border">
      {repos.map((repo) => (
        <li
          key={repo.id}
          className="hover:bg-card relative grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 px-4 py-3.5"
        >
          <div className="flex min-w-0 items-center gap-2">
            <Link
              to="/$owner/$repo"
              params={{ owner: repo.owner, repo: repo.name }}
              className="group truncate font-mono text-sm after:absolute after:inset-0"
            >
              <span className="text-muted-foreground">{repo.owner}/</span>
              <span className="group-hover:text-signal font-bold">{repo.name}</span>
            </Link>
            {repo.visibility === "private" ? (
              <Lock aria-label="private" className="text-muted-foreground size-3 shrink-0" />
            ) : null}
            {repo.forked_from === null ? null : (
              <GitFork aria-label="fork" className="text-muted-foreground size-3 shrink-0" />
            )}
          </div>
          <span className="text-faint font-mono text-xs">
            {ago(repo.pushed_at ?? repo.created_at)}
          </span>
          {repo.description === "" ? null : (
            <p className="text-muted-foreground col-span-2 line-clamp-2 text-sm">
              {repo.description}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
