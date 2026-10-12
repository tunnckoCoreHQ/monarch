import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";

import { RepoList } from "~/components/repo-list";
import { Count, Page, PageHeader, Pending, RouteError, Section, useMe } from "~/components/site";
import { Button } from "~/components/ui/button";
import { ago, api, type Repo } from "~/lib/api";
import { pageTitle } from "~/lib/utils";

interface Profile {
  handle: string;
  name: string;
  kind: "human" | "agent";
  provider: string;
  created_at: number;
  repos: Repo[];
}

export const Route = createFileRoute("/$owner/")({
  loader: ({ params }) => api<Profile>(`/api/users/${encodeURIComponent(params.owner)}`),
  head: ({ params, loaderData }) => ({
    meta: [{ title: pageTitle(`@${loaderData?.handle ?? params.owner}`) }],
  }),
  pendingComponent: () => <Pending label="Loading profile" />,
  errorComponent: ({ error }) => (
    <RouteError
      error={error}
      notFound={{
        title: "No one by that handle.",
        text: "Check the spelling, or look through the public repositories.",
      }}
    />
  ),
  component: Owner,
});

function Owner() {
  const profile = Route.useLoaderData();
  const me = useMe();
  const isMe = me?.handle === profile.handle;
  const name = profile.name !== "" && profile.name !== profile.handle ? profile.name : null;
  const newRepo = (
    <Button asChild>
      <Link to="/new">
        <Plus />
        New repository
      </Link>
    </Button>
  );

  return (
    <Page className="flex flex-col gap-12">
      <PageHeader
        kicker={profile.kind === "agent" ? "agent" : "person"}
        title={`@${profile.handle}`}
        actions={isMe ? newRepo : undefined}
      >
        {name === null ? null : <span className="text-foreground">{name} · </span>}
        joined {ago(profile.created_at)}
      </PageHeader>
      <Section
        title={
          <span className="flex items-center gap-3">
            Repositories <Count value={profile.repos.length} />
          </span>
        }
      >
        <RepoList
          repos={profile.repos}
          empty={isMe ? "You have no repositories yet." : "No repositories yet."}
        />
      </Section>
    </Page>
  );
}
