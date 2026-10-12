import { createFileRoute, Link } from "@tanstack/react-router";

import { DiffView } from "~/components/diff";
import { useRepo } from "~/components/repo";
import {
  Checks,
  Kicker,
  Ledger,
  LedgerRow,
  Page,
  Pending,
  RouteError,
  StatusBadge,
} from "~/components/site";
import { api, ago, type CombinedStatus, type Commit, type FileDiff } from "~/lib/api";
import { pageTitle } from "~/lib/utils";

const DATE = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export const Route = createFileRoute("/$owner/$repo/commit/$sha")({
  loader: ({ params }) =>
    api<{ commit: Commit; files: FileDiff[]; status: CombinedStatus }>(
      `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/commits/${params.sha}`,
    ),
  head: ({ params, loaderData }) => ({
    meta: [
      {
        title: pageTitle(
          loaderData?.commit.message.split("\n")[0] ?? params.sha.slice(0, 7),
          `${params.owner}/${params.repo}`,
        ),
      },
    ],
  }),
  pendingComponent: () => <Pending label="Loading commit" />,
  errorComponent: ({ error }) => (
    <RouteError
      error={error}
      notFound={{ title: "No such commit.", text: "This repository has no commit with that hash." }}
    />
  ),
  component: CommitView,
});

function CommitView() {
  const repo = useRepo();
  const { commit, files, status } = Route.useLoaderData();
  const [subject, ...rest] = commit.message.split("\n");
  const body = rest.join("\n").trim();
  const parents =
    commit.parents.length === 0 ? (
      <span className="text-muted-foreground">none, this is the first commit</span>
    ) : (
      <span className="flex flex-wrap gap-x-3">
        {commit.parents.map((parent) => (
          <Link
            key={parent}
            to="/$owner/$repo/commit/$sha"
            params={{ owner: repo.owner, repo: repo.name, sha: parent }}
            className="text-violet hover:underline"
          >
            {parent.slice(0, 7)}
          </Link>
        ))}
      </span>
    );

  return (
    <Page className="flex flex-col gap-8">
      <header className="min-w-0">
        <div className="flex items-center gap-3">
          <Kicker>commit {commit.sha.slice(0, 7)}</Kicker>
          <StatusBadge state={status.state} />
        </div>
        <h2 className="mt-3 text-3xl leading-tight font-black tracking-tight text-balance wrap-anywhere md:text-4xl">
          {subject}
        </h2>
        {body === "" ? null : (
          <pre className="text-muted-foreground mt-4 max-w-3xl font-mono text-sm wrap-anywhere whitespace-pre-wrap">
            {body}
          </pre>
        )}
      </header>
      <Ledger>
        <LedgerRow term="author">{commit.author.name}</LedgerRow>
        <LedgerRow term="committed">
          {ago(commit.committer.time)} · {DATE.format(new Date(commit.committer.time * 1000))}
        </LedgerRow>
        <LedgerRow term="sha">
          <span className="text-violet">{commit.sha}</span>
        </LedgerRow>
        <LedgerRow term="parents">{parents}</LedgerRow>
      </Ledger>
      {status.statuses.length === 0 ? null : <Checks status={status} className="border" />}
      <DiffView files={files} />
    </Page>
  );
}
