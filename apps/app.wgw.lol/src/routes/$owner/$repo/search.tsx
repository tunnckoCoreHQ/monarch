import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Search as SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useRepo } from "~/components/repo";
import { Empty, Field, fire, Page, Pending, RouteError } from "~/components/site";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { api } from "~/lib/api";
import { pageTitle } from "~/lib/utils";

interface SearchHit {
  path: string;
  start_line: number;
  end_line: number;
  snippet: string;
  score: number;
}

const LIMIT = 20;

export const Route = createFileRoute("/$owner/$repo/search")({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === "string" ? search.q : "",
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ params, deps }) =>
    deps.q.trim() === ""
      ? []
      : api<SearchHit[]>(
          `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/search?${new URLSearchParams({ q: deps.q, limit: String(LIMIT) }).toString()}`,
        ),
  head: ({ params }) => ({
    meta: [{ title: pageTitle("Search", `${params.owner}/${params.repo}`) }],
  }),
  pendingComponent: () => <Pending label="Searching" />,
  errorComponent: ({ error }) => <RouteError error={error} />,
  component: SearchPage,
});

function Snippet({ hit }: { hit: SearchHit }) {
  const lines = hit.snippet.split("\n");
  const gutterWidth = `calc(${String(hit.end_line).length}ch + 2rem)`;
  return (
    <div className="max-h-72 overflow-auto">
      <div className="w-max min-w-full py-2 font-mono text-[12.5px] leading-5">
        {lines.map((line, index) => (
          <div key={index} className="flex">
            <span
              aria-hidden
              style={{ width: gutterWidth }}
              className="text-faint bg-background sticky left-0 shrink-0 px-4 text-right select-none"
            >
              {hit.start_line + index}
            </span>
            <span className="pr-6 whitespace-pre">{line === "" ? " " : line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SearchPage() {
  const repo = useRepo();
  const hits = Route.useLoaderData();
  const { q } = Route.useSearch();
  const navigate = useNavigate();
  const [query, setQuery] = useState(q);
  // A navigation or Back changes q without remounting the page.
  useEffect(() => setQuery(q), [q]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    await navigate({
      to: "/$owner/$repo/search",
      params: { owner: repo.owner, repo: repo.name },
      search: { q: query.trim() },
    });
  };

  return (
    <Page className="flex flex-col gap-6">
      <form onSubmit={fire(submit)} className="bg-card flex flex-col gap-3 border p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Search the code" htmlFor="q" className="min-w-0 flex-1 basis-72">
            <Input
              id="q"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="where tokens are checked"
              className="h-11 text-base"
            />
          </Field>
          <Button type="submit" size="lg" disabled={query.trim() === ""}>
            <SearchIcon />
            Search
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Finds code by meaning on {repo.default_branch}.{" "}
          {repo.view === "full" ? "Members search every file." : "You search the public files."}
        </p>
      </form>
      {q.trim() === "" ? null : hits.length === 0 ? (
        <Empty>{`No matches for "${q}". A push shows up in search within about two minutes.`}</Empty>
      ) : (
        <ul className="flex flex-col gap-4">
          {hits.map((hit) => (
            <li key={`${hit.path}:${hit.start_line}`} className="min-w-0 border">
              <div className="bg-card flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2 font-mono text-xs">
                <Link
                  to="/$owner/$repo/blob"
                  params={{ owner: repo.owner, repo: repo.name }}
                  search={{ ref: repo.default_branch, path: hit.path }}
                  className="hover:text-signal min-w-0 font-semibold wrap-anywhere"
                >
                  {hit.path}:{hit.start_line}-{hit.end_line}
                </Link>
                <span className="text-muted-foreground ml-auto">{hit.score.toFixed(3)}</span>
              </div>
              <Snippet hit={hit} />
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
