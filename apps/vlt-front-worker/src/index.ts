import { Hono } from "hono";
import { validatePublishRequest, verifyPublishToken } from "./utils";
import type { PublishTag } from "./utils";

// COMMIT_SHA arrives as a deploy-time var, see the deploy script.
const app = new Hono<{ Bindings: Env & { COMMIT_SHA?: string } }>();

// Registry paths never start with "/-/health", so this cannot shadow a package.
app.get("/-/health", (c) => {
  const sha = c.env.COMMIT_SHA ?? "";
  const label = sha ? `/commit/${sha}` : "";
  const link = `https://github.com/tunnckoCoreHQ/monarch${label}`;

  return c.json({ ok: true, link, commit: sha ?? "unknwon" });
});

// Trusted publishing: npm-compatible clients POST the GitHub OIDC token here and use the
// returned token as the bearer for the publish itself. VLT has no OIDC support, so this worker
// is the exchange endpoint. The verified GitHub token is returned as-is; the write handler
// below verifies it again on every request.
app.post("/-/npm/v1/oidc/token/exchange/package/*", async (c) => {
  let name: string;
  try {
    name = decodeURIComponent(c.req.path.slice("/-/npm/v1/oidc/token/exchange/package/".length));
  } catch {
    return c.json({ message: "Invalid package name" }, 400);
  }
  if (!/^@tunnckocore\/[a-z0-9][a-z0-9._-]*$/.test(name)) {
    return c.json({ message: "Package not found" }, 404);
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
  if (!bearer) {
    return c.json({ message: "Unauthorized" }, 401);
  }
  try {
    await verifyPublishToken(bearer);
  } catch {
    return c.json({ message: "Unauthorized" }, 401);
  }
  return c.json({ token: bearer });
});

app.all("*", async (c) => {
  const request = c.req.raw;
  const url = new URL(request.url);

  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return c.notFound();
  }

  const isPackagePath = /^\/@tunnckocore\/[a-z0-9][a-z0-9._-]*(?:\/.*)?$/.test(path);
  const isDistTagPath =
    /^\/-\/package\/@tunnckocore\/[a-z0-9][a-z0-9._-]*\/dist-tags(?:\/.*)?$/.test(path);
  const hasTraversal = path.split("/").some((segment) => segment === "." || segment === "..");

  if ((!isPackagePath && !isDistTagPath) || hasTraversal) {
    return c.notFound();
  }

  const isRead = request.method === "GET" || request.method === "HEAD";
  const isWrite =
    request.method === "PUT" || request.method === "POST" || request.method === "DELETE";

  if (!isRead && !isWrite) {
    return c.text("Method not allowed", 405, { allow: "GET, HEAD, PUT, POST, DELETE" });
  }

  let token: string;
  if (isRead) {
    token = c.env.READ_TOKEN;
  } else {
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!bearer) {
      return c.text("Unauthorized", 401, {
        "www-authenticate": `Bearer realm="${url.host}"`,
      });
    }

    if (bearer.split(".").length === 3) {
      let tag: PublishTag;
      try {
        tag = await verifyPublishToken(bearer);
      } catch {
        return c.text("Unauthorized", 401);
      }
      try {
        if (!(await validatePublishRequest(request, path, tag))) {
          return c.text("Forbidden", 403);
        }
      } catch {
        return c.text("Invalid publish request", 400);
      }
    } else {
      const github = await fetch("https://api.github.com/user", {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${bearer}`,
          "user-agent": "vlt-front-worker",
          "x-github-api-version": "2026-03-10",
        },
      });
      if (github.status === 401) {
        return c.text("Unauthorized", 401);
      }
      if (!github.ok) {
        return c.text("GitHub authorization unavailable", 502);
      }

      const profile: unknown = await github.json();
      if (
        typeof profile !== "object" ||
        profile === null ||
        !("login" in profile) ||
        typeof profile.login !== "string"
      ) {
        return c.text("GitHub authorization unavailable", 502);
      }
      if (profile.login.toLowerCase() !== c.env.ALLOWED_GITHUB_LOGIN.toLowerCase()) {
        return c.text("Forbidden", 403);
      }
    }

    token = c.env.WRITE_TOKEN;
  }

  const upstreamPath = isDistTagPath
    ? url.pathname.replace(/(%40|@)tunnckocore%2f/i, "$1tunnckocore%252F")
    : url.pathname;
  const upstream = new URL(upstreamPath.replace(/^\/+/, ""), c.env.UPSTREAM_URL);
  upstream.search = url.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set("authorization", `Bearer ${token}`);

  const isTarball = path.includes("/-/") && path.endsWith(".tgz");
  const response = await fetch(upstream, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "follow",
    cf:
      isRead && isTarball
        ? {
            cacheEverything: true,
            cacheTtl: 31_536_000,
          }
        : undefined,
  });

  if (!isRead || !response.ok) {
    return response;
  }

  const responseHeaders = new Headers(response.headers);
  responseHeaders.set(
    "cache-control",
    isTarball ? "public, max-age=31536000, immutable" : "public, max-age=60",
  );

  if (
    isTarball ||
    request.method === "HEAD" ||
    !response.headers.get("content-type")?.includes("json")
  ) {
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  }

  const body = (await response.text()).replaceAll(c.env.UPSTREAM_URL, `${url.origin}/`);
  responseHeaders.delete("content-length");
  responseHeaders.delete("etag");

  return new Response(body, { status: response.status, headers: responseHeaders });
});

app.onError((_error, c) => c.text("Bad gateway", 502));

export default app;
