import { createFileRoute, Link, Outlet, useLocation, useRouter } from "@tanstack/react-router";
import { Eye, GitFork, Lock } from "lucide-react";
import { useEffect } from "react";

import { CopyField, Count, Page, Pending, RouteError } from "~/components/site";
import { Badge } from "~/components/ui/badge";
import { api, type RepoDetail } from "~/lib/api";
import { cn, pageTitle } from "~/lib/utils";

export const Route = createFileRoute("/$owner/$repo")({
  loader: ({ params }) =>
    api<RepoDetail>(
      `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`,
    ),
  head: ({ params }) => ({ meta: [{ title: pageTitle(`${params.owner}/${params.repo}`) }] }),
  pendingComponent: () => <Pending label="Loading repository" />,
  errorComponent: ({ error }) => (
    <RouteError
      error={error}
      notFound={{
        title: "No repository here.",
        text: "It does not exist, or it is private and you are not a member.",
      }}
    />
  ),
  component: RepoLayout,
});

interface RepoTab {
  label: string;
  to:
    | "/$owner/$repo"
    | "/$owner/$repo/commits"
    | "/$owner/$repo/pulls"
    | "/$owner/$repo/search"
    | "/$owner/$repo/settings";
  /** The first path segment after `/:owner/:repo` of every page under this tab. */
  sections: string[];
}

// Each tab stays active on the pages under it, so a pull request page keeps "Pull requests" lit.
const TABS: RepoTab[] = [
  { label: "Code", to: "/$owner/$repo", sections: ["", "blob"] },
  { label: "Commits", to: "/$owner/$repo/commits", sections: ["commits", "commit"] },
  { label: "Pull requests", to: "/$owner/$repo/pulls", sections: ["pulls", "pull"] },
  { label: "Search", to: "/$owner/$repo/search", sections: ["search"] },
  { label: "Settings", to: "/$owner/$repo/settings", sections: ["settings"] },
];

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

  if (repo.status === "ready" && repo.status_detail === null) {
    return null;
  }
  const failed = repo.status === "failed";
  const text =
    repo.status === "ready"
      ? repo.status_detail
      : `${STATUS_TEXT[repo.status]}${repo.status_detail === null ? "" : ` ${repo.status_detail}`}`;
  return (
    <div
      role="status"
      className={cn(
        "mt-6 flex items-start gap-3 border-l-2 px-4 py-3 font-mono text-sm",
        failed
          ? "border-destructive bg-destructive/10 text-destructive"
          : "border-violet bg-violet/10 text-violet",
      )}
    >
      {waiting ? (
        <span aria-hidden className="bg-violet mt-1.5 size-2 shrink-0 motion-safe:animate-pulse" />
      ) : null}
      <p className="min-w-0 wrap-anywhere">{text}</p>
    </div>
  );
}

function RepoLayout() {
  const repo = Route.useLoaderData();
  const section = useLocation({ select: (location) => location.pathname.split("/")[3] ?? "" });
  const tabs = TABS.filter((tab) => tab.label !== "Settings" || repo.role !== null);

  return (
    <>
      <div className="border-b">
        <Page className="pb-0">
          {/* The clone box takes its own full-width row, so the whole URL fits. */}
          <div className="grid gap-6">
            <div className="min-w-0">
              <p className="text-muted-foreground font-mono text-sm wrap-anywhere">
                <Link to="/$owner" params={{ owner: repo.owner }} className="hover:text-foreground">
                  {repo.owner}
                </Link>
                <span className="text-faint"> /</span>
              </p>
              <h1 className="mt-1 text-4xl leading-none font-black tracking-[-0.03em] wrap-anywhere md:text-5xl">
                <Link to="/$owner/$repo" params={{ owner: repo.owner, repo: repo.name }}>
                  {repo.name}
                </Link>
              </h1>
              {repo.description === "" ? null : (
                <p className="text-muted-foreground mt-3 max-w-2xl text-pretty">
                  {repo.description}
                </p>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Badge variant="outline">
                  {repo.visibility === "private" ? <Lock /> : null}
                  {repo.visibility}
                </Badge>
                {repo.view === "public" && repo.visibility === "public" ? (
                  <Badge
                    variant="violet"
                    title="You see the public history. Members see every path."
                  >
                    <Eye />
                    public view
                  </Badge>
                ) : null}
                {repo.hides_paths && repo.visibility === "public" ? (
                  <Badge variant="signal" title={repo.private_rules ?? ""}>
                    <Lock />
                    private paths
                  </Badge>
                ) : null}
                {repo.forked_from === null ? null : (
                  <span className="text-muted-foreground flex min-w-0 items-center gap-1 font-mono text-xs wrap-anywhere">
                    <GitFork className="size-3 shrink-0" /> fork of {repo.forked_from}
                  </span>
                )}
                {repo.source === null ? null : (
                  <span className="text-muted-foreground min-w-0 font-mono text-xs wrap-anywhere">
                    imported from {repo.source}
                  </span>
                )}
              </div>
            </div>
            {repo.role === null ? (
              <CopyField label="git" value={repo.clone_url} />
            ) : (
              // Narrow screens show the URL alone, and the button still copies the command.
              <CopyField
                label="member"
                value={`git clone ${repo.clone_url} -c http.proactiveAuth=basic`}
              >
                <span className="max-md:hidden">git clone </span>
                {repo.clone_url}
                <span className="max-md:hidden"> -c http.proactiveAuth=basic</span>
              </CopyField>
            )}
          </div>
          <StatusBanner repo={repo} />
          <nav
            aria-label="Repository"
            className="-mx-6 mt-8 flex [scrollbar-width:none] gap-6 overflow-x-auto [mask-image:linear-gradient(to_right,black_85%,transparent)] px-6 md:[mask-image:none]"
          >
            {tabs.map((tab) => {
              const active = tab.sections.includes(section);
              return (
                <Link
                  key={tab.label}
                  to={tab.to}
                  params={{ owner: repo.owner, repo: repo.name }}
                  activeOptions={{ exact: true, includeSearch: false }}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex shrink-0 items-center gap-2 border-b-2 pt-1 pb-3 font-mono text-xs tracking-wider whitespace-nowrap uppercase focus-visible:-outline-offset-2",
                    active
                      ? "border-signal text-foreground"
                      : "text-muted-foreground hover:text-foreground border-transparent",
                  )}
                >
                  {tab.label}
                  {tab.label === "Pull requests" && repo.open_pulls > 0 ? (
                    <Count value={repo.open_pulls} />
                  ) : null}
                </Link>
              );
            })}
          </nav>
        </Page>
      </div>
      <Outlet />
    </>
  );
}
