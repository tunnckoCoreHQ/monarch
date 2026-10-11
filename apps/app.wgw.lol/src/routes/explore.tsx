import { createFileRoute, Link } from "@tanstack/react-router";

import { RepoList } from "~/components/repo-list";
import { Page, PageHeader, Pending, RouteError } from "~/components/site";
import { Button } from "~/components/ui/button";
import { api, type Repo } from "~/lib/api";
import { pageTitle } from "~/lib/utils";

export const Route = createFileRoute("/explore")({
  loader: () => api<Repo[]>("/api/explore"),
  head: () => ({ meta: [{ title: pageTitle("Explore") }] }),
  pendingComponent: () => <Pending label="Loading repositories" />,
  errorComponent: ({ error }) => <RouteError error={error} />,
  component: Explore,
});

function Explore() {
  const repos = Route.useLoaderData();
  return (
    <Page className="flex flex-col gap-10">
      <PageHeader kicker="explore" title="Public repositories">
        Sorted by the last push. Anyone can read and clone them.
      </PageHeader>
      <RepoList
        repos={repos}
        empty="No public repositories yet."
        emptyAction={
          <Button asChild variant="outline">
            <Link to="/new">Create one</Link>
          </Button>
        }
      />
    </Page>
  );
}
