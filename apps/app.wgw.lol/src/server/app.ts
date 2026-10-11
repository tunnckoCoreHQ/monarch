import { Hono } from "hono";

import { api } from "./api";
import { type AppEnv, authenticate } from "./auth";
import { authmd } from "./authmd";
import { gitHttp } from "./git-http";
import { login } from "./login";
import { og } from "./og";
import { HttpError } from "./util";

const GIT_PATH = /^\/[^/]+\/[^/]+\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const CARD_PATH = /^\/og\/[^/]+\/[^/]+\.png$/;
const PREFIXES = ["/api/", "/auth/", "/oauth/", "/oauth2/", "/agent/", "/.well-known/"];

/** Paths the Hono app serves. Everything else is the TanStack Start web app. */
export function isServerPath(pathname: string): boolean {
  return (
    pathname === "/mcp" ||
    PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    GIT_PATH.test(pathname) ||
    CARD_PATH.test(pathname)
  );
}

export const app = new Hono<AppEnv>();

app.onError((error, c) => {
  const status = error instanceof HttpError ? error.status : 500;
  if (status === 500) {
    console.error(error);
  }
  const code = error instanceof HttpError ? error.code : "internal_error";
  const headers: Record<string, string> = {};
  if (status === 401) {
    // Git retries with the credential helper only after a Basic challenge.
    headers["www-authenticate"] = GIT_PATH.test(c.req.path)
      ? 'Basic realm="app.wgw.lol"'
      : `Bearer resource_metadata="${c.env.ORIGIN}/.well-known/oauth-protected-resource"`;
  }
  return Response.json(
    { error: code, message: error.message },
    {
      status,
      headers: { ...headers, "content-type": "application/json" },
    },
  );
});

app.notFound((c) =>
  c.json({ error: "not_found", message: `no route for ${c.req.method} ${c.req.path}` }, 404),
);

app.use("*", async (c, next) => {
  await authenticate(c);
  const method = c.req.method;
  // Cookie sessions must come from this origin for anything that changes state.
  if (
    c.get("principal")?.via !== "token" &&
    method !== "GET" &&
    method !== "HEAD" &&
    method !== "OPTIONS"
  ) {
    const origin = c.req.header("origin");
    const isGit = GIT_PATH.test(c.req.path);
    const isAgentProtocol =
      c.req.path.startsWith("/oauth2/") ||
      c.req.path.startsWith("/agent/") ||
      c.req.path.startsWith("/api/device/token") ||
      c.req.path.startsWith("/api/device/code");
    if (!isGit && !isAgentProtocol && origin !== undefined && origin !== c.env.ORIGIN) {
      throw new HttpError(403, "cross-origin request refused", "forbidden");
    }
  }
  return next();
});

app.get("/api/health", (c) => c.json({ ok: true, commit: c.env.COMMIT_SHA }));
app.all("/mcp", async (c) => {
  // The MCP SDK, zod, and Ajv load on the first MCP request, not on every cold start.
  const { handleMcp } = await import("./mcp");
  return handleMcp(c, (request) => app.fetch(request, c.env, c.executionCtx));
});
app.route("/", login);
app.route("/", authmd);
app.route("/api", api);
app.route("/", gitHttp);
app.route("/", og);
