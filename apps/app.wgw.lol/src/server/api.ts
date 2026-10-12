import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

import type { FileDiff } from "../git/diff";
import { type Person, ZERO_SHA } from "../git/objects";
import type { RefUpdate } from "../git/repo";
import { FILE_MODES } from "../git/tree";
import {
  type Access,
  access,
  type AppContext,
  type AppEnv,
  need,
  type Principal,
  requireUser,
} from "./auth";
import { openSecret, sealSecret } from "./crypto";
import {
  findRepo,
  findRepoById,
  listRepos,
  publicUser,
  recordEvent,
  repoJson,
  type RepoRow,
  type Role,
  requireFound,
  type User,
  userByHandle,
} from "./db";
import type { Env } from "./env";
import type { Result } from "./result";
import { deleteRepoIndex, enqueueIndex, searchPublic, searchRepo } from "./search";
import { fields, HttpError, isName, NAME_RULE, newId, now, readJson } from "./util";

export function repoStub(env: Env, repoId: string) {
  return env.REPO.getByName(repoId);
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new HttpError(
      result.status,
      result.error,
      result.status === 404 ? "not_found" : result.status === 409 ? "conflict" : "git_error",
    );
  }
  return result.value;
}

export function personOf(user: User): Person {
  return {
    name: user.name || user.handle,
    email: user.email ?? `${user.handle}@users.app.wgw.lol`,
    time: now(),
    tz: "+0000",
  };
}

async function loadRepo(c: AppContext): Promise<Access> {
  const repo = requireFound(
    await findRepo(c.env, c.req.param("owner") ?? "", c.req.param("name") ?? ""),
    "repository",
  );
  return access(c, repo);
}

/** The limit query parameter: a whole number from 1 to `max`, or `fallback` when it is missing. */
function limitOf(c: AppContext, fallback: number, max: number): number {
  const raw = c.req.query("limit");
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new HttpError(400, `limit must be a whole number from 1 to ${max}`, "invalid_request");
  }
  return limit;
}

const ENV_KINDS = new Set(["production", "staging", "preview", "development"]);
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const api = new Hono<AppEnv>();

/** Repositories the caller may list. A repository-limited key sees only public ones and its own. */
async function visibleRepos(c: AppContext, owner?: string): Promise<RepoRow[]> {
  const principal = c.get("principal");
  const repos = await listRepos(c.env, principal?.user ?? null, owner);
  const limit = principal?.repoId ?? null;
  return limit === null
    ? repos
    : repos.filter((repo) => repo.visibility === "public" || repo.id === limit);
}

api.get("/repos", async (c) => {
  const repos = await visibleRepos(c, c.req.query("owner"));
  return c.json(repos.map((repo) => repoJson(repo, c.env.ORIGIN)));
});

/**
 * Removes a repository whose create, import, or fork failed. When its Artifacts repos cannot be
 * deleted, the D1 row stays as failed, so the owner can delete it again later.
 */
async function discard(env: Env, id: string): Promise<void> {
  const cleaned = await repoStub(env, id).destroy();
  if (cleaned.ok) {
    await env.DB.prepare("DELETE FROM repos WHERE id = ?").bind(id).run();
  } else {
    await env.DB.prepare("UPDATE repos SET status = 'failed', status_detail = ? WHERE id = ?")
      .bind(`cleanup failed: ${cleaned.error}`, id)
      .run();
  }
}

api.post("/repos", async (c) => {
  const principal = requireUser(c, "write");
  if (principal.repoId !== null) {
    throw new HttpError(403, "a repository-scoped token cannot create repositories", "forbidden");
  }
  const input = await readJson<{
    name?: string;
    description?: string;
    visibility?: string;
    default_branch?: string;
    import_url?: string;
    import_branch?: string;
  }>(c, {
    name: "string",
    description: "string",
    visibility: "string",
    default_branch: "string",
    import_url: "string",
    import_branch: "string",
  });
  if (!isName(input.name)) {
    throw new HttpError(400, `name must be ${NAME_RULE}`, "invalid_request");
  }
  if (principal.user.provider === "authmd") {
    throw new HttpError(
      403,
      "claim this agent registration before creating repositories",
      "forbidden",
    );
  }
  const visibility = input.visibility === "private" ? "private" : "public";
  if (input.visibility !== undefined && input.visibility !== visibility) {
    throw new HttpError(400, "visibility must be public or private", "invalid_request");
  }
  const branch = input.default_branch ?? "main";
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch)) {
    throw new HttpError(400, "invalid default branch", "invalid_request");
  }
  let source: string | null = null;
  if (input.import_url !== undefined && input.import_url !== "") {
    let url: URL;
    try {
      url = new URL(input.import_url);
    } catch {
      throw new HttpError(400, "import_url is not a URL", "invalid_request");
    }
    if (url.protocol !== "https:") {
      throw new HttpError(400, "import from an https:// git remote", "invalid_request");
    }
    // The URL is stored and shown on the repository, and only public remotes can be imported.
    if (url.username !== "" || url.password !== "") {
      throw new HttpError(
        400,
        "import_url must not contain a username or password; only public remotes can be imported",
        "invalid_request",
      );
    }
    source = url.toString().replace(/\/+$/, "");
  }
  const importBranch = input.import_branch?.trim() || undefined;
  if (importBranch !== undefined && !/^[A-Za-z0-9._/-]{1,100}$/.test(importBranch)) {
    throw new HttpError(400, "invalid import_branch", "invalid_request");
  }
  const id = newId("repo");
  try {
    await c.env.DB.prepare(
      "INSERT INTO repos (id, owner_id, name, description, visibility, default_branch, source, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        id,
        principal.user.id,
        input.name,
        (input.description ?? "").slice(0, 400),
        visibility,
        importBranch ?? branch,
        source,
        source === null ? "ready" : "importing",
        now(),
      )
      .run();
  } catch {
    throw new HttpError(409, `${principal.user.handle}/${input.name} already exists`, "conflict");
  }
  const stub = repoStub(c.env, id);
  const started =
    source === null
      ? await stub.create(id, branch, (input.description ?? "").slice(0, 400))
      : await stub.importFrom(id, source, importBranch);
  if (!started.ok) {
    await discard(c.env, id);
    throw new HttpError(
      started.status === 500 ? 502 : started.status,
      source === null
        ? `could not create the repository: ${started.error}`
        : `import failed: ${started.error}`,
      source === null ? "git_error" : "import_failed",
    );
  }
  if (source === null) {
    await recordEvent(c.env, id, principal.user.id, "create", {});
  } else {
    await c.env.READY.create({
      id: `${id}-import`,
      params: { repoId: id, actorId: principal.user.id, kind: "import", source },
    });
  }
  return c.json(
    repoJson(requireFound(await findRepoById(c.env, id), "repository"), c.env.ORIGIN),
    201,
  );
});

api.get("/repos/:owner/:name", async (c) => {
  const grant = await loadRepo(c);
  const stub = repoStub(c.env, grant.repo.id);
  const refs = unwrap(await stub.refs(grant.view));
  const privacy =
    grant.role === null ? undefined : unwrap(await stub.privacy(grant.repo.default_branch));
  const open = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM pulls WHERE repo_id = ? AND state = 'open'",
  )
    .bind(grant.repo.id)
    .first<{ n: number }>();
  return c.json({
    ...repoJson(grant.repo, c.env.ORIGIN),
    role: grant.role,
    view: grant.view,
    empty: refs.refs.length === 0,
    branches: refs.refs
      .filter((ref) => ref.name.startsWith("refs/heads/"))
      .map((ref) => ref.name.slice(11)),
    tags: refs.refs
      .filter((ref) => ref.name.startsWith("refs/tags/"))
      .map((ref) => ref.name.slice(10)),
    open_pulls: open?.n ?? 0,
    private_rules: privacy?.rules ?? null,
    hides_paths: privacy?.hidden ?? false,
  });
});

/**
 * Visibility, deletion, collaborators, and environments are settings of the whole repository. A
 * key limited to one environment cannot change them, and a key limited to one repository changes
 * them only there.
 */
const repositorySettings = createMiddleware<AppEnv>(async (c, next) => {
  const principal = c.get("principal");
  if (principal !== null && principal.environment !== null) {
    throw new HttpError(
      403,
      `the token is limited to the ${principal.environment} environment and cannot change repository settings`,
      "forbidden",
    );
  }
  if (principal !== null && principal.repoId !== null) {
    // loadRepo answers 404 for a private repository outside the limit, as every route does.
    const grant = await loadRepo(c);
    if (grant.repo.id !== principal.repoId) {
      throw new HttpError(403, "the token is limited to another repository", "forbidden");
    }
  }
  return next();
});

api.patch("/repos/:owner/:name", repositorySettings, async (c) => {
  const grant = await loadRepo(c);
  need(grant, "admin");
  const input = await readJson<{
    description?: string;
    visibility?: string;
    default_branch?: string;
  }>(c, { description: "string", visibility: "string", default_branch: "string" });
  const repo = grant.repo;
  if (input.default_branch !== undefined && input.default_branch !== repo.default_branch) {
    // Artifacts fixes HEAD when the repository is created.
    throw new HttpError(400, "the default branch cannot change after creation", "invalid_request");
  }
  const visibility =
    input.visibility === "private" || input.visibility === "public"
      ? input.visibility
      : repo.visibility;
  if (input.visibility !== undefined && input.visibility !== visibility) {
    throw new HttpError(400, "visibility must be public or private", "invalid_request");
  }
  await c.env.DB.prepare("UPDATE repos SET description = ?, visibility = ? WHERE id = ?")
    .bind((input.description ?? repo.description).slice(0, 400), visibility, repo.id)
    .run();
  if (visibility !== repo.visibility) {
    // Every search chunk carries the repository's visibility.
    await enqueueIndex(c.env, repo.id);
  }
  return c.json(
    repoJson(requireFound(await findRepoById(c.env, repo.id), "repository"), c.env.ORIGIN),
  );
});

api.delete("/repos/:owner/:name", repositorySettings, async (c) => {
  const grant = await loadRepo(c);
  need(grant, "admin");
  unwrap(await repoStub(c.env, grant.repo.id).destroy());
  // The rows name the vectors, so the vectors go while the rows still exist. Vectors left by a
  // failure never show: every search checks the repository in D1.
  await deleteRepoIndex(c.env, grant.repo.id).catch((error: unknown) => {
    console.error(`could not delete the search index of ${grant.repo.id}`, error);
  });
  await c.env.DB.prepare("DELETE FROM repos WHERE id = ?").bind(grant.repo.id).run();
  return c.json({ ok: true });
});

api.post("/repos/:owner/:name/fork", async (c) => {
  const grant = await loadRepo(c);
  const principal = requireUser(c, "write");
  if (principal.repoId !== null) {
    throw new HttpError(403, "a repository-scoped token cannot create repositories", "forbidden");
  }
  if (grant.repo.status !== "ready") {
    throw new HttpError(409, `the repository is ${grant.repo.status}`, "conflict");
  }
  const input = await readJson<{ name?: string }>(c, { name: "string" });
  const name = input.name ?? grant.repo.name;
  if (!isName(name)) {
    throw new HttpError(400, `name must be ${NAME_RULE}`, "invalid_request");
  }
  const id = newId("repo");
  try {
    await c.env.DB.prepare(
      "INSERT INTO repos (id, owner_id, name, description, visibility, default_branch, forked_from, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'forking', ?)",
    )
      .bind(
        id,
        principal.user.id,
        name,
        grant.repo.description,
        grant.repo.visibility,
        grant.repo.default_branch,
        `${grant.repo.owner}/${grant.repo.name}`,
        now(),
      )
      .run();
  } catch {
    throw new HttpError(409, `${principal.user.handle}/${name} already exists`, "conflict");
  }
  const stub = repoStub(c.env, id);
  // An outsider's fork copies the public projection, so private paths never leave the repository.
  const started = await stub.forkFrom(id, grant.repo.id, grant.view, grant.repo.default_branch);
  if (!started.ok) {
    await discard(c.env, id);
    throw new HttpError(
      started.status === 500 ? 502 : started.status,
      `fork failed: ${started.error}`,
      "git_error",
    );
  }
  await c.env.READY.create({
    id: `${id}-fork`,
    params: {
      repoId: id,
      actorId: principal.user.id,
      kind: "fork",
      source: `${grant.repo.owner}/${grant.repo.name}`,
    },
  });
  await recordEvent(c.env, grant.repo.id, principal.user.id, "fork", {
    to: `${principal.user.handle}/${name}`,
  });
  return c.json(
    repoJson(requireFound(await findRepoById(c.env, id), "repository"), c.env.ORIGIN),
    201,
  );
});

// Direct Artifacts access for agents that want to skip the proxy. Members get the full repo;
// everyone else gets the public projection, read only.
api.post("/repos/:owner/:name/git-token", async (c) => {
  const grant = await loadRepo(c);
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const { success } = await c.env.LIMITER.limit({ key: `git-token:${ip}` });
  if (!success) {
    throw new HttpError(429, "too many requests, slow down", "rate_limited");
  }
  if (grant.repo.status !== "ready") {
    throw new HttpError(409, `the repository is ${grant.repo.status}`, "conflict");
  }
  const input = await readJson<{ scope?: string }>(c, { scope: "string" });
  const scope = input.scope === "write" ? "write" : "read";
  if (input.scope !== undefined && input.scope !== scope) {
    throw new HttpError(400, "scope must be read or write", "invalid_request");
  }
  if (scope === "write") {
    need(grant, "write");
  }
  const target = grant.view;
  const git = unwrap(await repoStub(c.env, grant.repo.id).gitAccess(target, scope, true));
  return c.json({ ...git, view: target }, 200, { "cache-control": "no-store" });
});

api.get("/repos/:owner/:name/refs", async (c) => {
  const grant = await loadRepo(c);
  return c.json(unwrap(await repoStub(c.env, grant.repo.id).refs(grant.view)));
});

// Re-reads the full Artifacts repo and republishes the public projection. Pushes through the
// proxy and push events do this on their own; this is for when neither has run yet. The mirror
// records the pushes it finds.
api.post("/repos/:owner/:name/sync", async (c) => {
  const grant = await loadRepo(c);
  need(grant, "write");
  const { updates, publishError } = unwrap(await repoStub(c.env, grant.repo.id).sync());
  return c.json({ updates, publish_error: publishError });
});

api.post("/repos/:owner/:name/branches", async (c) => {
  const grant = await loadRepo(c);
  const principal = need(grant, "write");
  const input = await readJson<{ name?: string; from?: string }>(c, {
    name: "string",
    from: "string",
  });
  const { update } = unwrap(
    await repoStub(c.env, grant.repo.id).createBranch(
      input.name ?? "",
      input.from ?? grant.repo.default_branch,
    ),
  );
  await recordEvent(c.env, grant.repo.id, principal.user.id, "push", { updates: [update] });
  return c.json(update, 201);
});

api.delete("/repos/:owner/:name/branches/*", async (c) => {
  const grant = await loadRepo(c);
  const principal = need(grant, "write");
  const branch = decodeURIComponent(c.req.path.split("/branches/")[1] ?? "");
  if (branch === grant.repo.default_branch) {
    throw new HttpError(400, "the default branch cannot be deleted", "invalid_request");
  }
  const { update } = unwrap(await repoStub(c.env, grant.repo.id).deleteBranch(branch));
  await recordEvent(c.env, grant.repo.id, principal.user.id, "push", { updates: [update] });
  return c.json(update);
});

function refOf(c: AppContext, grant: Access): string {
  return c.req.query("ref") || grant.repo.default_branch;
}

api.get("/repos/:owner/:name/tree", async (c) => {
  const grant = await loadRepo(c);
  return c.json(
    unwrap(
      await repoStub(c.env, grant.repo.id).tree(
        grant.view,
        refOf(c, grant),
        c.req.query("path") ?? "",
      ),
    ),
  );
});

function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

api.get("/repos/:owner/:name/blob", async (c) => {
  const grant = await loadRepo(c);
  const path = c.req.query("path") ?? "";
  const blob = unwrap(await repoStub(c.env, grant.repo.id).blob(grant.view, refOf(c, grant), path));
  const binary = isBinary(blob.content);
  return c.json({
    path,
    commit: blob.commit,
    sha: blob.sha,
    size: blob.size,
    binary,
    text: binary || blob.size > 1_000_000 ? null : new TextDecoder().decode(blob.content),
  });
});

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

api.get("/repos/:owner/:name/raw", async (c) => {
  const grant = await loadRepo(c);
  const path = c.req.query("path") ?? "";
  const blob = unwrap(await repoStub(c.env, grant.repo.id).blob(grant.view, refOf(c, grant), path));
  // Raster images keep their type, so pages and Markdown can show them. SVG can run scripts, so it
  // stays a download like every other binary.
  const image = IMAGE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""];
  return new Response(new Uint8Array(blob.content), {
    headers: {
      "content-type":
        image ??
        (isBinary(blob.content) ? "application/octet-stream" : "text/plain; charset=utf-8"),
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    },
  });
});

// Commit statuses: CI runners and agents post a state per context on a commit.

const STATUS_STATES = new Set(["pending", "success", "failure", "error"]);
const FULL_SHA = /^[0-9a-f]{40}$/;

type StatusState = "pending" | "success" | "failure" | "error";

interface StatusRow {
  sha: string;
  context: string;
  state: StatusState;
  description: string;
  target_url: string | null;
  creator: string | null;
  created_at: number;
  updated_at: number;
}

function statusJson({ sha: _sha, ...status }: StatusRow) {
  return status;
}

/** One state for the commit: any failure or error fails it, then any pending; null when empty. */
function combinedState(statuses: StatusRow[]): "pending" | "success" | "failure" | null {
  if (statuses.length === 0) {
    return null;
  }
  if (statuses.some((status) => status.state === "failure" || status.state === "error")) {
    return "failure";
  }
  return statuses.some((status) => status.state === "pending") ? "pending" : "success";
}

function combinedJson(sha: string, statuses: StatusRow[]) {
  return { sha, state: combinedState(statuses), statuses: statuses.map(statusJson) };
}

/**
 * The statuses of each commit, by the view's hash. Rows store full-repository hashes, so the
 * public view maps each public commit back to the full commits behind it. A commit the public
 * view leaves out has no public hash, so its statuses never reach a non-member.
 */
async function viewStatuses(
  env: Env,
  grant: Access,
  shas: string[],
): Promise<Map<string, StatusRow[]>> {
  const wanted = [...new Set(shas)].filter((sha) => FULL_SHA.test(sha));
  const out = new Map<string, StatusRow[]>(shas.map((sha) => [sha, []]));
  if (wanted.length === 0) {
    return out;
  }
  const sources =
    grant.view === "full"
      ? wanted.map((sha) => [sha])
      : unwrap(await repoStub(env, grant.repo.id).fullShas(wanted));
  const viewSha = new Map<string, string>();
  for (const [i, list] of sources.entries()) {
    for (const full of list) {
      viewSha.set(full, wanted[i]);
    }
  }
  if (viewSha.size === 0) {
    return out;
  }
  const rows = await env.DB.prepare(
    "SELECT statuses.sha, statuses.context, statuses.state, statuses.description, statuses.target_url, users.handle AS creator, statuses.created_at, statuses.updated_at FROM statuses LEFT JOIN users ON users.id = statuses.creator_id WHERE statuses.repo_id = ? AND statuses.sha IN (SELECT value FROM json_each(?)) ORDER BY statuses.context, statuses.updated_at DESC",
  )
    .bind(grant.repo.id, JSON.stringify([...viewSha.keys()]))
    .all<StatusRow>();
  for (const row of rows.results) {
    const list = out.get(viewSha.get(row.sha)!)!;
    // Several full commits can share one public commit; the newest status of a context wins.
    if (!list.some((status) => status.context === row.context)) {
      list.push(row);
    }
  }
  return out;
}

api.get("/repos/:owner/:name/statuses/:sha", async (c) => {
  const grant = await loadRepo(c);
  const sha = c.req.param("sha").toLowerCase();
  if (!FULL_SHA.test(sha)) {
    throw new HttpError(400, "sha must be a full 40-character commit hash", "invalid_request");
  }
  const statuses = await viewStatuses(c.env, grant, [sha]);
  return c.json(combinedJson(sha, statuses.get(sha) ?? []));
});

// Posting a context again replaces its state, description, and link.
api.post("/repos/:owner/:name/statuses/:sha", async (c) => {
  const grant = await loadRepo(c);
  const principal = need(grant, "write");
  const sha = c.req.param("sha").toLowerCase();
  if (!FULL_SHA.test(sha)) {
    throw new HttpError(400, "sha must be a full 40-character commit hash", "invalid_request");
  }
  const input = await readJson<{
    state?: string;
    context?: string;
    description?: string;
    target_url?: string;
  }>(c, { state: "string", context: "string", description: "string", target_url: "string" });
  if (input.state === undefined || !STATUS_STATES.has(input.state)) {
    throw new HttpError(
      400,
      "state must be pending, success, failure, or error",
      "invalid_request",
    );
  }
  const context = (input.context ?? "default").trim();
  if (context === "" || context.length > 100) {
    throw new HttpError(400, "context must be 1 to 100 characters", "invalid_request");
  }
  const description = input.description ?? "";
  if (description.length > 140) {
    throw new HttpError(400, "description must be at most 140 characters", "invalid_request");
  }
  let targetUrl: string | null = null;
  if (input.target_url !== undefined && input.target_url !== "") {
    let url: URL;
    try {
      url = new URL(input.target_url);
    } catch {
      throw new HttpError(400, "target_url is not a URL", "invalid_request");
    }
    if (url.protocol !== "https:") {
      throw new HttpError(400, "target_url must be an https:// URL", "invalid_request");
    }
    if (input.target_url.length > 2000) {
      throw new HttpError(400, "target_url must be at most 2000 characters", "invalid_request");
    }
    targetUrl = url.toString();
  }
  const commit = unwrap(await repoStub(c.env, grant.repo.id).resolve("full", sha));
  if (commit !== sha) {
    throw new HttpError(
      404,
      `${grant.repo.owner}/${grant.repo.name} has no commit ${sha}`,
      "not_found",
    );
  }
  const at = now();
  const row = await c.env.DB.prepare(
    "INSERT INTO statuses (repo_id, sha, context, state, description, target_url, creator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (repo_id, sha, context) DO UPDATE SET state = excluded.state, description = excluded.description, target_url = excluded.target_url, creator_id = excluded.creator_id, updated_at = excluded.updated_at RETURNING created_at",
  )
    .bind(
      grant.repo.id,
      sha,
      context,
      input.state,
      description,
      targetUrl,
      principal.user.id,
      at,
      at,
    )
    .first<{ created_at: number }>();
  return c.json(
    {
      context,
      state: input.state,
      description,
      target_url: targetUrl,
      creator: principal.user.handle,
      created_at: row?.created_at ?? at,
      updated_at: at,
    },
    201,
  );
});

api.get("/repos/:owner/:name/commits", async (c) => {
  const grant = await loadRepo(c);
  const commits = unwrap(
    await repoStub(c.env, grant.repo.id).log(
      grant.view,
      refOf(c, grant),
      limitOf(c, 30, 200),
      c.req.query("path"),
    ),
  );
  const statuses = await viewStatuses(
    c.env,
    grant,
    commits.map((commit) => commit.sha),
  );
  return c.json(
    commits.map((commit) => ({
      ...commit,
      status: combinedState(statuses.get(commit.sha) ?? []),
    })),
  );
});

api.get("/repos/:owner/:name/commits/:sha", async (c) => {
  const grant = await loadRepo(c);
  const shown = unwrap(
    await repoStub(c.env, grant.repo.id).showCommit(grant.view, c.req.param("sha")),
  );
  const statuses = await viewStatuses(c.env, grant, [shown.commit.sha]);
  return c.json({
    ...shown,
    status: combinedJson(shown.commit.sha, statuses.get(shown.commit.sha) ?? []),
  });
});

interface FileInput {
  path?: string;
  content?: string;
  encoding?: "utf-8" | "base64";
  delete?: boolean;
  mode?: string;
}

function decodeBase64(value: string, label: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    throw new HttpError(400, `${label} is not base64`, "invalid_request");
  }
}

// Agents can commit without a clone: send the files, get a commit. A new branch starts from
// `from`, else from the default branch.
api.post("/repos/:owner/:name/commits", async (c) => {
  const grant = await loadRepo(c);
  const principal = need(grant, "write");
  const input = await readJson<{
    branch?: string;
    message?: string;
    expected_sha?: string;
    from?: string;
    files?: unknown[];
  }>(c, {
    branch: "string",
    message: "string",
    expected_sha: "string",
    from: "string",
    files: "array",
  });
  const files = (input.files ?? []).map((item, index) => {
    const label = `files[${index}]`;
    const file = fields<FileInput>(
      item,
      { path: "string", content: "string", encoding: "string", delete: "boolean", mode: "string" },
      label,
    );
    const path = (file.path ?? "").replace(/^\/+/, "");
    if (
      path === "" ||
      path
        .split("/")
        .some(
          (segment) => segment === "" || segment === "." || segment === ".." || segment === ".git",
        )
    ) {
      throw new HttpError(400, `invalid path ${file.path}`, "invalid_request");
    }
    if (file.delete === true) {
      return { path, content: null };
    }
    if (file.mode !== undefined && !FILE_MODES.has(file.mode)) {
      throw new HttpError(
        400,
        `mode of ${path} must be 100644, 100755, or 120000`,
        "invalid_request",
      );
    }
    const content =
      file.encoding === "base64"
        ? decodeBase64(file.content ?? "", `${label}.content`)
        : new TextEncoder().encode(file.content ?? "");
    return { path, content, mode: file.mode };
  });
  if (files.length === 0 || (input.message ?? "").trim() === "") {
    throw new HttpError(400, "send a message and at least one file", "invalid_request");
  }
  const branch = input.branch ?? grant.repo.default_branch;
  const result = unwrap(
    await repoStub(c.env, grant.repo.id).commitFiles(
      branch,
      input.expected_sha,
      input.message!,
      personOf(principal.user),
      files,
      input.from,
    ),
  );
  await afterPush(c.env, grant.repo, principal.user.id, [result.update]);
  return c.json({ sha: result.sha, branch }, 201);
});

api.get("/repos/:owner/:name/compare", async (c) => {
  const grant = await loadRepo(c);
  const base = c.req.query("base") || grant.repo.default_branch;
  return c.json(
    unwrap(
      await repoStub(c.env, grant.repo.id).compare(grant.view, base, c.req.query("head") ?? ""),
    ),
  );
});

function searchInput(c: AppContext): { query: string; limit: number } {
  const query = (c.req.query("q") ?? "").trim().slice(0, 500);
  if (query === "") {
    throw new HttpError(400, "send a query in q", "invalid_request");
  }
  // Vectorize returns up to 50 matches with their metadata.
  return { query, limit: limitOf(c, 10, 50) };
}

// Semantic code search over the default branch tip. Non-members search the public paths only.
api.get("/repos/:owner/:name/search", async (c) => {
  const grant = await loadRepo(c);
  const { query, limit } = searchInput(c);
  return c.json(await searchRepo(c.env, grant, query, limit));
});

/**
 * The public view's hash of each full-repository commit, or null where the public view does not
 * have it. The zero hash of a created or deleted ref stays as it is.
 */
async function publicShas(env: Env, repoId: string, shas: string[]) {
  const wanted = [...new Set(shas)].filter((sha) => sha !== ZERO_SHA);
  const mapped = wanted.length === 0 ? [] : unwrap(await repoStub(env, repoId).publicShas(wanted));
  const out = new Map<string, string | null>([[ZERO_SHA, ZERO_SHA]]);
  for (const [i, sha] of wanted.entries()) {
    out.set(sha, mapped[i]);
  }
  return out;
}

interface RepoEvent {
  id: string;
  type: string;
  actor: string | null;
  /** Pushes carry `updates`; a merge carries the merge commit's `sha`. */
  data: { updates?: RefUpdate[]; sha?: string | null };
  created_at: number;
}

// What everyone may see of a repository's activity. Secret reads stay with the members.
const PUBLIC_EVENTS = new Set([
  "create",
  "import",
  "fork",
  "push",
  "pull_opened",
  "pull_closed",
  "pull_reopened",
  "pull_merged",
]);

/**
 * The activity a non-member may see. Pushes and merges show the public view's hashes, and a push
 * update the public view does not show, such as one that touched only private paths, is left out.
 */
async function publicEvents(env: Env, repoId: string, events: RepoEvent[]): Promise<RepoEvent[]> {
  const shown = events.filter((event) => PUBLIC_EVENTS.has(event.type));
  const shas = await publicShas(
    env,
    repoId,
    shown.flatMap(({ data }) => [
      ...(data.updates ?? []).flatMap((update) => [update.old, update.new]),
      ...(typeof data.sha === "string" ? [data.sha] : []),
    ]),
  );
  const out: RepoEvent[] = [];
  for (const event of shown) {
    const { updates, sha } = event.data;
    if (updates !== undefined) {
      const kept = updates.flatMap((update) => {
        const old = shas.get(update.old) ?? null;
        const next = shas.get(update.new) ?? null;
        return old === null || next === null || old === next ? [] : [{ ...update, old, new: next }];
      });
      if (kept.length > 0) {
        out.push({ ...event, data: { updates: kept } });
      }
    } else if (typeof sha === "string") {
      out.push({ ...event, data: { ...event.data, sha: shas.get(sha) ?? null } });
    } else {
      out.push(event);
    }
  }
  return out;
}

api.get("/repos/:owner/:name/events", async (c) => {
  const grant = await loadRepo(c);
  const rows = await c.env.DB.prepare(
    "SELECT events.*, users.handle AS actor FROM events LEFT JOIN users ON users.id = events.actor_id WHERE events.repo_id = ? ORDER BY events.created_at DESC LIMIT 50",
  )
    .bind(grant.repo.id)
    .all<{ id: string; type: string; data: string; created_at: number; actor: string | null }>();
  const events = rows.results.map((row): RepoEvent => ({
    id: row.id,
    type: row.type,
    actor: row.actor,
    data: JSON.parse(row.data),
    created_at: row.created_at,
  }));
  return c.json(
    grant.view === "public" ? await publicEvents(c.env, grant.repo.id, events) : events,
  );
});

export async function afterPush(
  env: Env,
  repo: RepoRow,
  actorId: string | null,
  updates: Array<{ ref: string; old: string; new: string }>,
): Promise<void> {
  if (updates.length === 0) {
    return;
  }
  // The first branch pushed to an empty repository becomes git's HEAD; keep D1 in step with it.
  const head = unwrap(await repoStub(env, repo.id).refs("full")).head.replace(/^refs\/heads\//, "");
  await env.DB.prepare("UPDATE repos SET pushed_at = ?, default_branch = ? WHERE id = ?")
    .bind(now(), head, repo.id)
    .run();
  await recordEvent(env, repo.id, actorId, "push", { updates });
  env.METRICS.writeDataPoint({
    blobs: ["push", `${repo.owner}/${repo.name}`],
    doubles: [updates.length],
    indexes: [repo.id],
  });
  if (updates.some((update) => update.ref === `refs/heads/${head}`)) {
    // The commit has landed; a failed enqueue waits for the next push or the hourly check.
    await enqueueIndex(env, repo.id).catch((error: unknown) => {
      console.error(`could not enqueue a search index for ${repo.id}`, error);
    });
  }
}

// Pull requests.

interface PullRow {
  id: string;
  number: number;
  title: string;
  body: string;
  author_id: string;
  head: string;
  base: string;
  state: "open" | "closed" | "merged";
  merge_sha: string | null;
  base_sha: string | null;
  head_sha: string | null;
  merged_by: string | null;
  summary: string | null;
  created_at: number;
  updated_at: number;
  author: string;
}

const PULL_SELECT =
  "SELECT pulls.*, users.handle AS author FROM pulls JOIN users ON users.id = pulls.author_id";

async function loadPull(c: AppContext, grant: Access): Promise<PullRow> {
  const row = await c.env.DB.prepare(`${PULL_SELECT} WHERE pulls.repo_id = ? AND pulls.number = ?`)
    .bind(grant.repo.id, Number(c.req.param("number")))
    .first<PullRow>();
  return requireFound(row, "pull request");
}

function pullJson(pull: PullRow, repo: RepoRow, origin: string) {
  const { id: _id, author_id: _author, ...rest } = pull;
  return { ...rest, web_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}` };
}

/**
 * Pull requests store full-repository hashes. A non-member gets the public view's hashes
 * instead, or null where the public view does not have the commit.
 */
async function viewPulls(env: Env, grant: Access, pulls: PullRow[]): Promise<PullRow[]> {
  if (grant.view === "full") {
    return pulls;
  }
  const shas = await publicShas(
    env,
    grant.repo.id,
    pulls
      .flatMap((pull) => [pull.merge_sha, pull.base_sha, pull.head_sha])
      .filter((sha) => sha !== null),
  );
  const view = (sha: string | null) => (sha === null ? null : (shas.get(sha) ?? null));
  return pulls.map((pull) => ({
    ...pull,
    merge_sha: view(pull.merge_sha),
    base_sha: view(pull.base_sha),
    head_sha: view(pull.head_sha),
  }));
}

/**
 * The head commit of each pull request, in the view: the branch tip until the merge, then the
 * tip that was merged. Null when the branch is gone.
 */
async function pullHeads(env: Env, grant: Access, pulls: PullRow[]): Promise<Array<string | null>> {
  const refs = pulls.some((pull) => pull.state !== "merged")
    ? unwrap(await repoStub(env, grant.repo.id).refs(grant.view)).refs
    : [];
  return pulls.map((pull) =>
    pull.state === "merged"
      ? pull.head_sha
      : (refs.find((ref) => ref.name === `refs/heads/${pull.head}`)?.sha ?? null),
  );
}

api.get("/repos/:owner/:name/pulls", async (c) => {
  const grant = await loadRepo(c);
  const state = c.req.query("state") ?? "open";
  const query =
    state === "all"
      ? c.env.DB.prepare(
          `${PULL_SELECT} WHERE pulls.repo_id = ? ORDER BY pulls.number DESC LIMIT 100`,
        ).bind(grant.repo.id)
      : c.env.DB.prepare(
          `${PULL_SELECT} WHERE pulls.repo_id = ? AND pulls.state = ? ORDER BY pulls.number DESC LIMIT 100`,
        ).bind(grant.repo.id, state);
  const rows = await viewPulls(c.env, grant, (await query.all<PullRow>()).results);
  const heads = await pullHeads(c.env, grant, rows);
  const statuses = await viewStatuses(
    c.env,
    grant,
    heads.filter((sha) => sha !== null),
  );
  return c.json(
    rows.map((row, i) => ({
      ...pullJson(row, grant.repo, c.env.ORIGIN),
      status: combinedState(statuses.get(heads[i] ?? "") ?? []),
    })),
  );
});

api.post("/repos/:owner/:name/pulls", async (c) => {
  const grant = await loadRepo(c);
  const principal = need(grant, "write");
  const input = await readJson<{ title?: string; body?: string; head?: string; base?: string }>(c, {
    title: "string",
    body: "string",
    head: "string",
    base: "string",
  });
  const base = input.base ?? grant.repo.default_branch;
  if ((input.title ?? "").trim() === "" || (input.head ?? "") === "") {
    throw new HttpError(400, "send a title and a head branch", "invalid_request");
  }
  if (input.head === base) {
    throw new HttpError(400, "head and base must differ", "invalid_request");
  }
  const compare = unwrap(await repoStub(c.env, grant.repo.id).compare("full", base, input.head!));
  if (compare.commits.length === 0) {
    throw new HttpError(400, `${input.head} has no commits that ${base} lacks`, "invalid_request");
  }
  const id = newId("pr");
  await c.env.DB.prepare(
    "INSERT INTO pulls (id, repo_id, number, title, body, author_id, head, base, state, created_at, updated_at) SELECT ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, 'open', ?, ? FROM pulls WHERE repo_id = ?",
  )
    .bind(
      id,
      grant.repo.id,
      input.title!.slice(0, 200),
      (input.body ?? "").slice(0, 60_000),
      principal.user.id,
      input.head,
      base,
      now(),
      now(),
      grant.repo.id,
    )
    .run();
  const pull = requireFound(
    await c.env.DB.prepare(`${PULL_SELECT} WHERE pulls.id = ?`).bind(id).first<PullRow>(),
    "pull request",
  );
  await recordEvent(c.env, grant.repo.id, principal.user.id, "pull_opened", {
    number: pull.number,
    title: pull.title,
  });
  return c.json(pullJson(pull, grant.repo, c.env.ORIGIN), 201);
});

api.get("/repos/:owner/:name/pulls/:number", async (c) => {
  const grant = await loadRepo(c);
  const [pull] = await viewPulls(c.env, grant, [await loadPull(c, grant)]);
  const stub = repoStub(c.env, grant.repo.id);
  let compare: unknown = null;
  if (pull.state === "open") {
    const result = await stub.compare(grant.view, pull.base, pull.head);
    compare = result.ok ? result.value : { error: result.error };
  } else if (pull.base_sha !== null && pull.head_sha !== null) {
    // The tips at merge time, so the commits and files stay what was merged.
    const result = await stub.compare(grant.view, pull.base_sha, pull.head_sha);
    compare = result.ok ? { ...result.value, merged: true } : { error: result.error };
  }
  const [head] = await pullHeads(c.env, grant, [pull]);
  const status =
    head === null
      ? null
      : combinedJson(head, (await viewStatuses(c.env, grant, [head])).get(head) ?? []);
  return c.json({ ...pullJson(pull, grant.repo, c.env.ORIGIN), compare, status });
});

api.get("/repos/:owner/:name/pulls/:number/diff", async (c) => {
  const grant = await loadRepo(c);
  const pull = await loadPull(c, grant);
  const stub = repoStub(c.env, grant.repo.id);
  let result: { files: FileDiff[] };
  if (pull.state !== "open" && pull.base_sha !== null && pull.head_sha !== null) {
    // The tips at merge time, as in the detail route, so deleted or moved branches do not matter.
    const [shown] = await viewPulls(c.env, grant, [pull]);
    if (shown.base_sha === null || shown.head_sha === null) {
      throw new HttpError(404, "the pull request has no public commits", "not_found");
    }
    result = unwrap(await stub.compare(grant.view, shown.base_sha, shown.head_sha));
  } else {
    result = unwrap(await stub.compare(grant.view, pull.base, pull.head));
  }
  return c.text(result.files.map((file: FileDiff) => file.patch).join(""), 200, {
    "content-type": "text/x-diff; charset=utf-8",
  });
});

api.patch("/repos/:owner/:name/pulls/:number", async (c) => {
  const grant = await loadRepo(c);
  const principal = need(grant, "write");
  const pull = await loadPull(c, grant);
  const input = await readJson<{ title?: string; body?: string; state?: string }>(c, {
    title: "string",
    body: "string",
    state: "string",
  });
  if (pull.state === "merged" && input.state !== undefined) {
    throw new HttpError(400, "a merged pull request stays merged", "invalid_request");
  }
  const state = input.state === "closed" || input.state === "open" ? input.state : pull.state;
  await c.env.DB.prepare(
    "UPDATE pulls SET title = ?, body = ?, state = ?, updated_at = ? WHERE id = ?",
  )
    .bind(
      (input.title ?? pull.title).slice(0, 200),
      (input.body ?? pull.body).slice(0, 60_000),
      state,
      now(),
      pull.id,
    )
    .run();
  if (state !== pull.state) {
    await recordEvent(
      c.env,
      grant.repo.id,
      principal.user.id,
      state === "closed" ? "pull_closed" : "pull_reopened",
      { number: pull.number },
    );
  }
  return c.json(pullJson(await loadPull(c, grant), grant.repo, c.env.ORIGIN));
});

api.post("/repos/:owner/:name/pulls/:number/merge", async (c) => {
  const grant = await loadRepo(c);
  const principal = need(grant, "write");
  const pull = await loadPull(c, grant);
  if (pull.state !== "open") {
    throw new HttpError(400, `the pull request is ${pull.state}`, "invalid_request");
  }
  const input = await readJson<{ message?: string }>(c, { message: "string" });
  const message =
    input.message ?? `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`;
  const merged = unwrap(
    await repoStub(c.env, grant.repo.id).merge(
      pull.base,
      pull.head,
      message,
      personOf(principal.user),
    ),
  );
  await c.env.DB.prepare(
    "UPDATE pulls SET state = 'merged', merge_sha = ?, base_sha = ?, head_sha = ?, merged_by = ?, updated_at = ? WHERE id = ?",
  )
    .bind(merged.sha, merged.update.old, merged.head, principal.user.id, now(), pull.id)
    .run();
  await afterPush(c.env, grant.repo, principal.user.id, [merged.update]);
  await recordEvent(c.env, grant.repo.id, principal.user.id, "pull_merged", {
    number: pull.number,
    sha: merged.sha,
  });
  return c.json({ merged: true, sha: merged.sha });
});

api.get("/repos/:owner/:name/pulls/:number/comments", async (c) => {
  const grant = await loadRepo(c);
  const pull = await loadPull(c, grant);
  const rows = await c.env.DB.prepare(
    "SELECT comments.id, comments.body, comments.created_at, users.handle AS author, users.kind AS author_kind FROM comments JOIN users ON users.id = comments.author_id WHERE comments.pull_id = ? ORDER BY comments.created_at",
  )
    .bind(pull.id)
    .all();
  return c.json(rows.results);
});

api.post("/repos/:owner/:name/pulls/:number/comments", async (c) => {
  const grant = await loadRepo(c);
  const principal = requireUser(c, "write");
  if (grant.role === null && grant.repo.visibility === "private") {
    throw new HttpError(404, "repository not found", "not_found");
  }
  // Anyone signed in may comment on a public repository, but a key limited to one repository
  // writes only there.
  if (principal.repoId !== null && principal.repoId !== grant.repo.id) {
    throw new HttpError(403, "the token is limited to another repository", "forbidden");
  }
  const pull = await loadPull(c, grant);
  const input = await readJson<{ body?: string }>(c, { body: "string" });
  if ((input.body ?? "").trim() === "") {
    throw new HttpError(400, "the comment is empty", "invalid_request");
  }
  const id = newId("cmt");
  await c.env.DB.prepare(
    "INSERT INTO comments (id, pull_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, pull.id, principal.user.id, input.body!.slice(0, 60_000), now())
    .run();
  return c.json({ id, body: input.body, author: principal.user.handle, created_at: now() }, 201);
});

// A short summary of the pull request diff from Workers AI.
api.post("/repos/:owner/:name/pulls/:number/summary", async (c) => {
  const grant = await loadRepo(c);
  need(grant, "write");
  const pull = await loadPull(c, grant);
  // Anyone who can read the pull request reads the summary, so it sees only the public view.
  const result = unwrap(
    await repoStub(c.env, grant.repo.id).compare("public", pull.base, pull.head),
  );
  const diff = result.files
    .map((file: FileDiff) => file.patch)
    .join("")
    .slice(0, 24_000);
  const commits = result.commits.map((commit) => `- ${commit.message.split("\n")[0]}`).join("\n");
  const answer = await c.env.AI.run(
    "@cf/meta/llama-3.1-8b-instruct-fast",
    {
      messages: [
        {
          role: "system",
          content:
            "You review pull requests. Write 3 to 6 short plain bullet points: what changed, and anything risky. No preamble.",
        },
        { role: "user", content: `Title: ${pull.title}\n\nCommits:\n${commits}\n\nDiff:\n${diff}` },
      ],
      max_tokens: 400,
    },
    { gateway: { id: c.env.AI_GATEWAY } },
  );
  const summary =
    typeof answer === "object" && answer !== null && "response" in answer
      ? String(answer.response)
      : "";
  await c.env.DB.prepare("UPDATE pulls SET summary = ? WHERE id = ?").bind(summary, pull.id).run();
  return c.json({ summary });
});

// Collaborators.

api.on(
  ["PUT", "POST", "DELETE"],
  [
    "/repos/:owner/:name/collaborators/*",
    "/repos/:owner/:name/environments",
    "/repos/:owner/:name/environments/*",
  ],
  repositorySettings,
);

api.get("/repos/:owner/:name/collaborators", async (c) => {
  const grant = await loadRepo(c);
  need(grant, "read");
  const rows = await c.env.DB.prepare(
    "SELECT users.handle, users.name, users.kind, collaborators.role FROM collaborators JOIN users ON users.id = collaborators.user_id WHERE repo_id = ? ORDER BY users.handle",
  )
    .bind(grant.repo.id)
    .all();
  return c.json([{ handle: grant.repo.owner, role: "owner" }, ...rows.results]);
});

api.put("/repos/:owner/:name/collaborators/:handle", async (c) => {
  const grant = await loadRepo(c);
  need(grant, "admin");
  const input = await readJson<{ role?: Role }>(c, { role: "string" });
  const role = input.role === "write" || input.role === "admin" ? input.role : "read";
  if (input.role !== undefined && input.role !== role) {
    throw new HttpError(400, "role must be read, write, or admin", "invalid_request");
  }
  const user = requireFound(await userByHandle(c.env, c.req.param("handle")), "user");
  if (user.id === grant.repo.owner_id) {
    throw new HttpError(400, "the owner already has admin access", "invalid_request");
  }
  await c.env.DB.prepare(
    "INSERT INTO collaborators (repo_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (repo_id, user_id) DO UPDATE SET role = excluded.role",
  )
    .bind(grant.repo.id, user.id, role, now())
    .run();
  return c.json({ handle: user.handle, role });
});

api.delete("/repos/:owner/:name/collaborators/:handle", async (c) => {
  const grant = await loadRepo(c);
  need(grant, "admin");
  const user = requireFound(await userByHandle(c.env, c.req.param("handle")), "user");
  await c.env.DB.prepare("DELETE FROM collaborators WHERE repo_id = ? AND user_id = ?")
    .bind(grant.repo.id, user.id)
    .run();
  return c.json({ ok: true });
});

// Environments, variables, and secrets.

/**
 * A key limited to one environment works in that environment only. Repository values, environment
 * "", apply to every environment, so writing them needs a key without that limit. The key still
 * reads them, as part of its environment's values.
 */
function checkEnvironmentScope(principal: Principal, environment: string): void {
  if (principal.environment !== null && principal.environment !== environment) {
    throw new HttpError(
      403,
      `the token is limited to the ${principal.environment} environment`,
      "forbidden",
    );
  }
}

/** A 404 unless the repository has the environment. The repository level, "", always exists. */
async function requireEnvironment(env: Env, repoId: string, name: string): Promise<void> {
  if (name !== "") {
    requireFound(
      await env.DB.prepare("SELECT 1 FROM environments WHERE repo_id = ? AND name = ?")
        .bind(repoId, name)
        .first(),
      "environment",
    );
  }
}

api.get("/repos/:owner/:name/environments", async (c) => {
  const grant = await loadRepo(c);
  const principal = need(grant, "read");
  const only = principal.environment;
  const envs = await c.env.DB.prepare(
    "SELECT name, kind, created_at FROM environments WHERE repo_id = ? ORDER BY name",
  )
    .bind(grant.repo.id)
    .all<{ name: string; kind: string; created_at: number }>();
  const vars = await c.env.DB.prepare(
    "SELECT environment, name, secret, value, updated_at FROM variables WHERE repo_id = ? ORDER BY name",
  )
    .bind(grant.repo.id)
    .all<{
      environment: string;
      name: string;
      secret: number;
      value: string;
      updated_at: number;
    }>();
  const list = (environment: string) =>
    vars.results
      .filter((row) => row.environment === environment)
      .map((row) => ({
        name: row.name,
        secret: row.secret === 1,
        value: row.secret === 1 ? null : row.value,
        updated_at: row.updated_at,
      }));
  return c.json({
    repository: list(""),
    environments: envs.results
      .filter((item) => only === null || item.name === only)
      .map((item) => ({ ...item, variables: list(item.name) })),
  });
});

api.post("/repos/:owner/:name/environments", async (c) => {
  const grant = await loadRepo(c);
  const principal = need(grant, "admin");
  const input = await readJson<{ name?: string; kind?: string }>(c, {
    name: "string",
    kind: "string",
  });
  if (!isName(input.name)) {
    throw new HttpError(400, `name must be ${NAME_RULE}`, "invalid_request");
  }
  if (input.kind !== undefined && !ENV_KINDS.has(input.kind)) {
    throw new HttpError(400, `kind must be one of ${[...ENV_KINDS].join(", ")}`, "invalid_request");
  }
  checkEnvironmentScope(principal, input.name);
  // An existing environment keeps its kind unless the request names one. The reads and the write
  // run in one batch, which D1 runs as a transaction, so no other request lands between them.
  const select = c.env.DB.prepare(
    "SELECT kind FROM environments WHERE repo_id = ? AND name = ?",
  ).bind(grant.repo.id, input.name);
  const [before, , after] = await c.env.DB.batch<{ kind: string }>([
    select,
    c.env.DB.prepare(
      input.kind === undefined
        ? "INSERT INTO environments (repo_id, name, kind, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (repo_id, name) DO NOTHING"
        : "INSERT INTO environments (repo_id, name, kind, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (repo_id, name) DO UPDATE SET kind = excluded.kind",
    ).bind(grant.repo.id, input.name, input.kind ?? "development", now()),
    select,
  ]);
  const kind = after.results[0]?.kind ?? input.kind ?? "development";
  return c.json({ name: input.name, kind }, before.results.length === 0 ? 201 : 200);
});

api.delete("/repos/:owner/:name/environments/:env", async (c) => {
  const grant = await loadRepo(c);
  const principal = need(grant, "admin");
  checkEnvironmentScope(principal, c.req.param("env"));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM variables WHERE repo_id = ? AND environment = ?").bind(
      grant.repo.id,
      c.req.param("env"),
    ),
    c.env.DB.prepare("DELETE FROM environments WHERE repo_id = ? AND name = ?").bind(
      grant.repo.id,
      c.req.param("env"),
    ),
  ]);
  return c.json({ ok: true });
});

api.put("/repos/:owner/:name/variables/:var", async (c) => {
  const grant = await loadRepo(c);
  const principal = need(grant, "admin");
  const input = await readJson<{ value?: string; secret?: boolean; environment?: string }>(c, {
    value: "string",
    secret: "boolean",
    environment: "string",
  });
  const name = c.req.param("var");
  const environment = input.environment ?? "";
  checkEnvironmentScope(principal, environment);
  if (!VAR_NAME.test(name) || typeof input.value !== "string" || input.value.length > 32_768) {
    throw new HttpError(
      400,
      "names are letters, digits, and underscores; values are strings up to 32 KB",
      "invalid_request",
    );
  }
  await requireEnvironment(c.env, grant.repo.id, environment);
  const secret = input.secret !== false;
  const value = secret
    ? await sealSecret(c.env, grant.repo.id, `${grant.repo.id}:${environment}:${name}`, input.value)
    : input.value;
  await c.env.DB.prepare(
    "INSERT INTO variables (repo_id, environment, name, secret, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (repo_id, environment, name) DO UPDATE SET secret = excluded.secret, value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
  )
    .bind(grant.repo.id, environment, name, secret ? 1 : 0, value, principal.user.id, now())
    .run();
  return c.json({ name, environment, secret });
});

api.delete("/repos/:owner/:name/variables/:var", async (c) => {
  const grant = await loadRepo(c);
  const principal = need(grant, "admin");
  const environment = c.req.query("environment") ?? "";
  checkEnvironmentScope(principal, environment);
  await c.env.DB.prepare("DELETE FROM variables WHERE repo_id = ? AND environment = ? AND name = ?")
    .bind(grant.repo.id, environment, c.req.param("var"))
    .run();
  return c.json({ ok: true });
});

// Decrypted values for one environment: repository values first, environment values override.
// This is how an agent or a deploy script pulls its configuration.
api.get("/repos/:owner/:name/env", async (c) => {
  const grant = await loadRepo(c);
  const principal = need(grant, "write", "secrets");
  const environment = c.req.query("environment") ?? "";
  checkEnvironmentScope(
    principal,
    environment === "" ? (principal.environment ?? "") : environment,
  );
  await requireEnvironment(c.env, grant.repo.id, environment);
  const rows = await c.env.DB.prepare(
    "SELECT environment, name, secret, value FROM variables WHERE repo_id = ? AND environment IN ('', ?) ORDER BY environment, name",
  )
    .bind(grant.repo.id, environment)
    .all<{ environment: string; name: string; secret: number; value: string }>();
  const values: Record<string, string> = {};
  for (const row of rows.results) {
    values[row.name] =
      row.secret === 1
        ? await openSecret(
            c.env,
            grant.repo.id,
            `${grant.repo.id}:${row.environment}:${row.name}`,
            row.value,
          )
        : row.value;
  }
  await recordEvent(c.env, grant.repo.id, principal.user.id, "secrets_read", {
    environment,
    names: Object.keys(values),
  });
  if (c.req.query("format") === "dotenv") {
    const text = Object.entries(values)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join("\n");
    return c.text(`${text}\n`);
  }
  return c.json(values);
});

api.get("/users/:handle", async (c) => {
  const user = requireFound(await userByHandle(c.env, c.req.param("handle")), "user");
  const repos = await visibleRepos(c, user.handle);
  return c.json({
    ...publicUser(user),
    created_at: user.created_at,
    repos: repos.map((repo) => repoJson(repo, c.env.ORIGIN)),
  });
});

api.get("/explore", async (c) => {
  const repos = await c.env.DB.prepare(
    "SELECT repos.*, users.handle AS owner FROM repos JOIN users ON users.id = repos.owner_id WHERE repos.visibility = 'public' ORDER BY COALESCE(repos.pushed_at, repos.created_at) DESC LIMIT 50",
  ).all<RepoRow>();
  return c.json(repos.results.map((repo) => repoJson(repo, c.env.ORIGIN)));
});

// Code search across public repositories, public paths only.
api.get("/search", async (c) => {
  const { query, limit } = searchInput(c);
  return c.json(await searchPublic(c.env, query, limit));
});
