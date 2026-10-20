import { createFileRoute } from "@tanstack/react-router";
import { GitBranch } from "lucide-react";
import { useMemo } from "react";

import { PathCrumbs, useRepo } from "~/components/repo";
import { Page, Pending, RouteError } from "~/components/site";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { api, bytes } from "~/lib/api";
import { renderMarkdown } from "~/lib/markdown";
import { pageTitle } from "~/lib/utils";

interface Blob {
  path: string;
  commit: string;
  sha: string;
  size: number;
  binary: boolean;
  text: string | null;
}

export const Route = createFileRoute("/$owner/$repo/blob")({
  validateSearch: (search: Record<string, unknown>) => ({
    ref: typeof search.ref === "string" ? search.ref : undefined,
    path: typeof search.path === "string" ? search.path : "",
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ params, deps }) =>
    api<Blob>(
      `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/blob?${new URLSearchParams({ ref: deps.ref ?? "", path: deps.path }).toString()}`,
    ),
  head: ({ params, match }) => ({
    meta: [{ title: pageTitle(match.search.path, `${params.owner}/${params.repo}`) }],
  }),
  pendingComponent: () => <Pending label="Loading file" />,
  errorComponent: ({ error }) => (
    <RouteError
      error={error}
      notFound={{ title: "No file here.", text: "This path does not exist on that branch or tag." }}
    />
  ),
  component: BlobView,
});

function BlobView() {
  const repo = useRepo();
  const blob = Route.useLoaderData();
  const search = Route.useSearch();
  const ref = search.ref ?? repo.default_branch;
  const isMarkdown = /\.(md|markdown)$/i.test(blob.path);
  // The raw route serves these with their image type; see IMAGE_TYPES in the API.
  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(blob.path);
  const html = useMemo(
    () => (isMarkdown && blob.text !== null ? renderMarkdown(blob.text) : ""),
    [isMarkdown, blob.text],
  );
  // A final newline ends the last line; it does not start another one.
  const lines = blob.text === null ? [] : blob.text.replace(/\n$/, "").split("\n");
  const gutterWidth = `calc(${String(lines.length).length}ch + 2rem)`;
  const raw = `/api/repos/${repo.owner}/${repo.name}/raw?${new URLSearchParams({ ref: blob.commit, path: blob.path }).toString()}`;

  return (
    <Page className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Badge variant="outline" className="h-9 max-w-full px-2.5 normal-case">
          <GitBranch />
          <span className="truncate">{ref}</span>
        </Badge>
        <PathCrumbs owner={repo.owner} name={repo.name} refName={ref} path={blob.path} />
      </div>
      <div className="min-w-0 border">
        <div className="bg-card text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2 font-mono text-xs">
          <span>{bytes(blob.size)}</span>
          {blob.text === null ? null : (
            <span>
              {lines.length} {lines.length === 1 ? "line" : "lines"}
            </span>
          )}
          <span className="text-violet">{blob.sha.slice(0, 7)}</span>
          <Button asChild size="xs" variant="outline" className="ml-auto">
            <a href={raw}>Raw</a>
          </Button>
        </div>
        {blob.text === null && isImage ? (
          <div className="bg-background flex justify-center p-4 md:p-8">
            <img src={raw} alt={blob.path} className="max-h-[70vh] max-w-full object-contain" />
          </div>
        ) : null}
        {blob.text === null && !isImage ? (
          <p className="text-muted-foreground px-6 py-12 text-center font-mono text-sm">
            Binary or large file. Open the raw file to see it.
          </p>
        ) : null}
        {blob.text === "" ? (
          <p className="text-muted-foreground px-6 py-12 text-center font-mono text-sm">
            Empty file.
          </p>
        ) : null}
        {blob.text !== null && blob.text !== "" && isMarkdown ? (
          // The renderer escapes raw HTML and drops unsafe link schemes.
          <div
            className="prose-md px-4 py-5 md:px-8 md:py-6"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : null}
        {blob.text !== null && blob.text !== "" && !isMarkdown ? (
          <div className="overflow-x-auto">
            <div className="w-max min-w-full py-2 font-mono text-[12.5px] leading-5">
              {lines.map((line, index) => (
                <div key={index} className="group hover:bg-card flex">
                  <span
                    aria-hidden
                    style={{ width: gutterWidth }}
                    className="text-faint bg-background group-hover:bg-card sticky left-0 shrink-0 px-4 text-right select-none"
                  >
                    {index + 1}
                  </span>
                  <span className="pr-6 whitespace-pre">{line === "" ? " " : line}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Page>
  );
}
