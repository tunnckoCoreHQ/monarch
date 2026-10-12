import { Hono } from "hono";

import { readCommands } from "../git/protocol";
import { repoStub, unwrap } from "./api";
import { type Access, access, type AppContext, type AppEnv } from "./auth";
import { findRepo } from "./db";
import { HttpError } from "./util";

const AUTH_CHALLENGE = 'Basic realm="app.wgw.lol"';
// Request headers git sends that Artifacts needs to see. Protocol v2 rides on Git-Protocol.
const FORWARD_REQUEST = ["content-type", "accept", "content-encoding", "git-protocol"];
const FORWARD_RESPONSE = ["content-type", "cache-control", "expires", "pragma"];

function challenge(message: string): Response {
  return new Response(`${message}\n`, {
    status: 401,
    headers: { "www-authenticate": AUTH_CHALLENGE, "content-type": "text/plain" },
  });
}

async function resolveGit(c: AppContext, write: boolean): Promise<Access | Response> {
  const owner = c.req.param("owner") ?? "";
  const name = (c.req.param("repo") ?? "").replace(/\.git$/, "");
  const repo = await findRepo(c.env, owner, name);
  const principal = c.get("principal");
  if (repo === null) {
    return principal === null
      ? challenge("repository not found, or sign in")
      : new Response("repository not found\n", { status: 404 });
  }
  let grant;
  try {
    grant = await access(c, repo);
  } catch {
    return principal === null
      ? challenge("authentication required")
      : new Response("repository not found\n", { status: 404 });
  }
  if (repo.status !== "ready") {
    return new Response(`${repo.owner}/${repo.name} is ${repo.status}; try again shortly\n`, {
      status: 503,
      headers: { "retry-after": "5" },
    });
  }
  if (write) {
    if (principal === null) {
      return challenge("pushing needs an API token as the password");
    }
    if (grant.role === null || grant.role === "read" || !principal.scopes.has("write")) {
      return new Response(`no write access to ${repo.owner}/${repo.name}\n`, { status: 403 });
    }
  }
  return grant;
}

/**
 * Forwards one git smart HTTP request to Artifacts. Members reach the full repo; everyone else
 * reaches the public projection, which never contained the private paths.
 */
async function forward(
  c: AppContext,
  grant: Access,
  path: string,
  write: boolean,
  body: ReadableStream<Uint8Array> | null = c.req.raw.body,
): Promise<Response> {
  const target = write || grant.view === "full" ? "full" : "public";
  const git = unwrap(
    await repoStub(c.env, grant.repo.id).gitAccess(target, write ? "write" : "read", false),
  );
  const headers = new Headers({
    authorization: `Bearer ${git.token}`,
    "user-agent": "git/2.47.0 (app.wgw.lol)",
  });
  for (const name of FORWARD_REQUEST) {
    const value = c.req.header(name);
    if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const upstream = await fetch(`${git.remote}${path}`, {
    method: c.req.method,
    headers,
    body: c.req.method === "POST" ? body : undefined,
  });
  const out = new Headers();
  for (const name of FORWARD_RESPONSE) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      out.set(name, value);
    }
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/** Keeps a known request length, so Artifacts sees the same request git sent. */
function withLength(body: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(length)) {
    return body;
  }
  const fixed = new FixedLengthStream(length);
  void body.pipeTo(fixed.writable).catch(() => undefined);
  return fixed.readable;
}

/** Git smart HTTP. The Worker checks access; Artifacts speaks the protocol. */
export const gitHttp = new Hono<AppEnv>();

gitHttp.get("/:owner/:repo/info/refs", async (c) => {
  const service = c.req.query("service");
  if (service !== "git-upload-pack" && service !== "git-receive-pack") {
    throw new HttpError(403, "this server speaks smart HTTP only; use git 2.x", "invalid_request");
  }
  const write = service === "git-receive-pack";
  const grant = await resolveGit(c, write);
  if (grant instanceof Response) {
    return grant;
  }
  return forward(c, grant, `/info/refs?service=${service}`, write);
});

gitHttp.post("/:owner/:repo/git-upload-pack", async (c) => {
  const grant = await resolveGit(c, false);
  if (grant instanceof Response) {
    return grant;
  }
  c.env.METRICS.writeDataPoint({
    blobs: ["fetch", `${grant.repo.owner}/${grant.repo.name}`, grant.view],
    doubles: [1],
    indexes: [grant.repo.id],
  });
  return forward(c, grant, "/git-upload-pack", false);
});

gitHttp.post("/:owner/:repo/git-receive-pack", async (c) => {
  const grant = await resolveGit(c, true);
  if (grant instanceof Response) {
    return grant;
  }
  const repo = grant.repo;
  const stub = repoStub(c.env, repo.id);
  let body = c.req.raw.body;
  let claim: string | undefined;
  const actor = grant.principal?.user.id;
  // git does not compress receive-pack bodies; one that is compressed is forwarded unread.
  if (body !== null && actor !== undefined && c.req.header("content-encoding") === undefined) {
    const read = await readCommands(body);
    body = withLength(read.body, Number(c.req.header("content-length")));
    // The mirror records the push from whichever sync sees it first, this one or the queue's.
    // The claim tells it who pushed either way.
    const claimed = await stub.claimPush(actor, read.commands);
    if (claimed.ok) {
      claim = claimed.value;
    } else {
      console.error(`could not claim a push to ${repo.id}: ${claimed.error}`);
    }
  }
  const response = await forward(c, grant, "/git-receive-pack", true, body);
  // The report is small. Read it all so the sync below runs after Artifacts applied the push.
  const report = await response.arrayBuffer();
  c.executionCtx.waitUntil(
    (async () => {
      const synced = await stub.sync();
      if (!synced.ok) {
        // The claims stay, for the queue's sync, until they expire.
        console.error(`sync after push failed for ${repo.id}: ${synced.error}`);
      } else if (claim !== undefined) {
        await stub.releaseClaims(claim);
      }
    })(),
  );
  return new Response(report, { status: response.status, headers: response.headers });
});
