// Serves the static Blume build, and adds the HTTP behavior that Blume's own server build would add:
// Markdown for `Accept: text/markdown`, a Markdown 404 for agents, and JSON 404s under /api/.

interface Env {
  ASSETS: Fetcher;
}

const markdownHeaders = { "content-type": "text/markdown; charset=utf-8", vary: "Accept" };

const wantsMarkdown = (request: Request) =>
  (request.headers.get("accept") ?? "").includes("text/markdown");

// A page path has no file extension. Blume writes each page's Markdown copy at `<path>.md`.
const markdownPath = (pathname: string) => {
  if (/\.[a-z0-9]+$/i.test(pathname)) {
    return undefined;
  }
  const route = pathname.replace(/\/+$/, "");
  return route === "" ? "/index.md" : `${route}.md`;
};

const serveMarkdown = async (request: Request, env: Env, path: string) => {
  const page = await env.ASSETS.fetch(new URL(path, request.url));
  if (page.ok) {
    return new Response(page.body, { headers: markdownHeaders });
  }
  const notFound = await env.ASSETS.fetch(new URL("/404.md", request.url));
  return new Response(notFound.body, { status: 404, headers: markdownHeaders });
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const path = markdownPath(pathname);

    if (path && wantsMarkdown(request)) {
      return serveMarkdown(request, env, path);
    }

    const response = await env.ASSETS.fetch(request);

    if (response.status === 404 && pathname.startsWith("/api/")) {
      return Response.json(
        {
          error: {
            code: "not_found",
            message: `No docs API resource at ${pathname}.`,
            docs: "/openapi.json",
          },
        },
        { status: 404 },
      );
    }

    if (!path) {
      return response;
    }

    // A page answers in HTML or Markdown by the Accept header, so caches must keep them apart.
    const page = new Response(response.body, response);
    page.headers.append("vary", "Accept");
    return page;
  },
} satisfies ExportedHandler<Env>;
