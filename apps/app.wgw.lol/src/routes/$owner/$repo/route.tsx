import { createFileRoute, Link, Outlet, useRouter } from "@tanstack/react-router";
import { Eye, GitFork, Lock } from "lucide-react";
import { useEffect } from "react";

import { CopyField, Page } from "~/components/site";
import { Badge } from "~/components/ui/badge";
import { api, type RepoDetail } from "~/lib/api";

export const Route = createFileRoute("/$owner/$repo")({
  loader: ({ params }) =>
    api<RepoDetail>(
      `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`,
    ),
  component: RepoLayout,
});

function Tab({ to, label, exact }: { to: string; label: string; exact?: boolean }) {
  const params = Route.useParams();
  return (
    <Link
      to={to}
      params={params}
      activeOptions={{ exact: exact ?? false, includeSearch: false }}
      className="text-muted-foreground hover:text-foreground [&.active]:border-signal [&.active]:text-foreground border-b-2 border-transparent px-1 pb-3 font-mono text-xs tracking-wider uppercase"
    >
      {label}
    </Link>
  );
}

const STATUS_TEXT: Record<"importing" | "forking" | "failed", string> = {
  importing:
    "Cloudflare Artifacts is importing this repository. This page refreshes until it is ready.",
  forking:
    "Cloudflare Artifacts is forking this repository. This page refreshes until it is ready.",
  failed: "The import or fork failed.",
};

function StatusBanner({ repo }: { repo: RepoDetail }) {
  const router = useRouter();
  const waiting = repo.status === "importing" || repo.status === "forking";
  useEffect(() => {
    if (!waiting) {
      return;
    }
    const timer = setInterval(() => {
      router.invalidate().catch((error: unknown) => console.error(error));
    }, 4000);
    return () => clearInterval(timer);
  }, [waiting, router]);
  if (repo.status === "ready") {
    return null;
  }
  return (
    <p
      className={`mt-4 border px-4 py-3 font-mono text-sm ${repo.status === "failed" ? "border-destructive text-destructive" : "border-violet text-violet"}`}
    >
      {STATUS_TEXT[repo.status]}
      {repo.status_detail === null ? null : ` ${repo.status_detail}`}
    </p>
  );
}

function RepoLayout() {
  const repo = Route.useLoaderData();
  return (
    <>
      <div className="border-b">
        <Page className="pb-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-2xl">
              <Link
                to="/$owner"
                params={{ owner: repo.owner }}
                className="text-muted-foreground hover:text-foreground"
              >
                {repo.owner}
              </Link>
              <span className="text-muted-foreground"> / </span>
              <Link
                to="/$owner/$repo"
                params={{ owner: repo.owner, repo: repo.name }}
                className="font-bold"
              >
                {repo.name}
              </Link>
            </h1>
            <Badge variant="outline" className="font-mono">
              {repo.visibility === "private" ? <Lock className="size-3" /> : null}
              {repo.visibility}
            </Badge>
            {repo.view === "public" && repo.visibility === "public" ? (
              <Badge variant="outline" className="border-violet text-violet font-mono">
                <Eye className="size-3" />
                public view
              </Badge>
            ) : null}
            {repo.hides_paths ? (
              <Badge
                variant="outline"
                className="border-signal text-signal font-mono"
                title={repo.private_rules ?? ""}
              >
                <Lock className="size-3" />
                has private paths
              </Badge>
            ) : null}
            {repo.forked_from === null ? null : (
              <span className="text-muted-foreground flex items-center gap-1 font-mono text-xs">
                <GitFork className="size-3" /> fork of {repo.forked_from}
              </span>
            )}
            {repo.source === null ? null : (
              <span className="text-muted-foreground font-mono text-xs">
                imported from {repo.source}
              </span>
            )}
            <div className="ml-auto w-full max-w-md">
              <CopyField
                label={repo.role === null ? "git" : "member"}
                value={
                  repo.role === null
                    ? repo.clone_url
                    : `git -c http.proactiveAuth=basic clone ${repo.clone_url}`
                }
              />
            </div>
          </div>
          {repo.description === "" ? null : (
            <p className="text-muted-foreground mt-3">{repo.description}</p>
          )}
          <StatusBanner repo={repo} />
          <nav className="mt-6 flex gap-6">
            <Tab to="/$owner/$repo" label="Code" exact />
            <Tab to="/$owner/$repo/commits" label="Commits" />
            <Tab
              to="/$owner/$repo/pulls"
              label={`Pull requests${repo.open_pulls > 0 ? ` · ${repo.open_pulls}` : ""}`}
            />
            {repo.role === null ? null : <Tab to="/$owner/$repo/settings" label="Settings" />}
          </nav>
        </Page>
      </div>
      <Outlet />
    </>
  );
}
