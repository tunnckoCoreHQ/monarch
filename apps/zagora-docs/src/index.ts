import { apiNotFoundResponse } from "blume/ai/api/handlers.ts";

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
    const url = new URL(request.url);
    const path = markdownPath(url.pathname);

    if (path && wantsMarkdown(request)) {
      return serveMarkdown(request, env, path);
    }

    const response = await env.ASSETS.fetch(request);

    if (response.status === 404 && url.pathname.startsWith("/api/")) {
      return apiNotFoundResponse(request, { base: "", site: url.origin });
    }

    if (!path) {
      return response;
    }

    const page = new Response(response.body, response);
    page.headers.append("vary", "Accept");
    return page;
  },
} satisfies ExportedHandler<Env>;
