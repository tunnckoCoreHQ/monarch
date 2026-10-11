import { Hono } from "hono";

import type { FileDiff } from "../git/diff";
import type { Person } from "../git/objects";
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
import { HttpError, isName, newId, now } from "./util";

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

function body<T>(c: AppContext): Promise<T> {
  return c.req.json<T>().catch(() => {
    throw new HttpError(400, "the body must be JSON", "invalid_request");
  });
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
  const input = await body<{
    name?: string;
    description?: string;
    visibility?: string;
    default_branch?: string;
    import_url?: string;
    import_branch?: string;
  }>(c);
  if (!isName(input.name)) {
    throw new HttpError(
      400,
      "name must be 1-100 letters, digits, dots, dashes, or underscores",
      "invalid_request",
    );
  }
  if (principal.user.provider === "authmd") {
    throw new HttpError(
      403,
      "claim this agent registration before creating repositories",
      "forbidden",
    );
  }
  const visibility = input.visibility === "private" ? "private" : "public";
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

api.patch("/repos/:owner/:name", async (c) => {
  const grant = await loadRepo(c);
  need(grant, "admin");
  const input = await body<{ description?: string; visibility?: string; default_branch?: string }>(
    c,
  );
  const repo = grant.repo;
  if (input.default_branch !== undefined && input.default_branch !== repo.default_branch) {
    // Artifacts fixes HEAD when the repository is created.
    throw new HttpError(400, "the default branch cannot change after creation", "invalid_request");
  }
  const visibility =
    input.visibility === "private" || input.visibility === "public"
      ? input.visibility
      : repo.visibility;
  await c.env.DB.prepare("UPDATE repos SET description = ?, visibility = ? WHERE id = ?")
    .bind((input.description ?? repo.description).slice(0, 400), visibility, repo.id)
    .run();
  return c.json(
    repoJson(requireFound(await findRepoById(c.env, repo.id), "repository"), c.env.ORIGIN),
  );
});

api.delete("/repos/:owner/:name", async (c) => {
  const grant = await loadRepo(c);
  need(grant, "admin");
  unwrap(await repoStub(c.env, grant.repo.id).destroy());
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
  const input = await body<{ name?: string }>(c).catch(() => ({ name: undefined }));
  const name = input.name ?? grant.repo.name;
  if (!isName(name)) {
    throw new HttpError(400, "invalid repository name", "invalid_request");
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
  const input = await body<{ scope?: string }>(c).catch(() => ({ scope: undefined }));
  const scope = input.scope === "write" ? "write" : "read";
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
// proxy do this on their own; this is for pushes made with a direct Artifacts token.
api.post("/repos/:owner/:name/sync", async (c) => {
  const grant = await loadRepo(c);
  need(grant, "write");
  const { updates, publishError } = unwrap(await repoStub(c.env, grant.repo.id).sync());
  if (updates.length > 0) {
    await afterPush(c.env, grant.repo, grant.principal?.user.id ?? null, updates);
  }
  return c.json({ updates, publish_error: publishError });
});

api.post("/repos/:owner/:name/branches", async (c) => {
  const grant = await loadRepo(c);
  const principal = need(grant, "write");
  const input = await body<{ name?: string; from?: string }>(c);
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

api.get("/repos/:owner/:name/raw", async (c) => {
  const grant = await loadRepo(c);
  const blob = unwrap(
    await repoStub(c.env, grant.repo.id).blob(
      grant.view,
      refOf(c, grant),
      c.req.query("path") ?? "",
    ),
  );
  return new Response(new Uint8Array(blob.content), {
    headers: {
      "content-type": isBinary(blob.content)
        ? "application/octet-stream"
        : "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    },
  });
});

api.get("/repos/:owner/:name/commits", async (c) => {
  const grant = await loadRepo(c);
  const limit = Math.min(Number(c.req.query("limit") ?? 30) || 30, 200);
  return c.json(
    unwrap(
      await repoStub(c.env, grant.repo.id).log(
        grant.view,
        refOf(c, grant),
        limit,
        c.req.query("path"),
      ),
    ),
  );
});

api.get("/repos/:owner/:name/commits/:sha", async (c) => {
  const grant = await loadRepo(c);
  return c.json(
    unwrap(await repoStub(c.env, grant.repo.id).showCommit(grant.view, c.req.param("sha"))),
  );
});

interface FileInput {
  path?: string;
  content?: string;
  encoding?: "utf-8" | "base64";
  delete?: boolean;
}

// Agents can commit without a clone: send the files, get a commit.
api.post("/repos/:owner/:name/commits", async (c) => {
  const grant = await loadRepo(c);
  const principal = need(grant, "write");
  const input = await body<{
    branch?: string;
    message?: string;
    expected_sha?: string;
    files?: FileInput[];
  }>(c);
  const files = (input.files ?? []).map((file) => {
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
    const content =
      file.encoding === "base64"
        ? Uint8Array.from(atob(file.content ?? ""), (char) => char.charCodeAt(0))
        : new TextEncoder().encode(file.content ?? "");
    return { path, content };
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

api.get("/repos/:owner/:name/events", async (c) => {
  const grant = await loadRepo(c);
  const rows = await c.env.DB.prepare(
    "SELECT events.*, users.handle AS actor FROM events LEFT JOIN users ON users.id = events.actor_id WHERE events.repo_id = ? ORDER BY events.created_at DESC LIMIT 50",
  )
    .bind(grant.repo.id)
    .all<{ id: string; type: string; data: string; created_at: number; actor: string | null }>();
  return c.json(
    rows.results.map((row) => ({
      id: row.id,
      type: row.type,
      actor: row.actor,
      data: JSON.parse(row.data),
      created_at: row.created_at,
    })),
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
  const rows = await query.all<PullRow>();
  return c.json(rows.results.map((row) => pullJson(row, grant.repo, c.env.ORIGIN)));
});

api.post("/repos/:owner/:name/pulls", async (c) => {
  const grant = await loadRepo(c);
  const principal = need(grant, "write");
  const input = await body<{ title?: string; body?: string; head?: string; base?: string }>(c);
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
  const pull = await loadPull(c, grant);
  const stub = repoStub(c.env, grant.repo.id);
  let compare: unknown = null;
  if (pull.state === "open") {
    const result = await stub.compare(grant.view, pull.base, pull.head);
    compare = result.ok ? result.value : { error: result.error };
  } else if (pull.merge_sha !== null) {
    const result = await stub.showCommit(grant.view, pull.merge_sha);
    compare = result.ok ? { commits: [], files: result.value.files, merged: true } : null;
  }
  return c.json({ ...pullJson(pull, grant.repo, c.env.ORIGIN), compare });
});

api.get("/repos/:owner/:name/pulls/:number/diff", async (c) => {
  const grant = await loadRepo(c);
  const pull = await loadPull(c, grant);
  const result = unwrap(
    await repoStub(c.env, grant.repo.id).compare(grant.view, pull.base, pull.head),
  );
  return c.text(result.files.map((file: FileDiff) => file.patch).join(""), 200, {
    "content-type": "text/x-diff; charset=utf-8",
  });
});

api.patch("/repos/:owner/:name/pulls/:number", async (c) => {
  const grant = await loadRepo(c);
  const principal = need(grant, "write");
  const pull = await loadPull(c, grant);
  const input = await body<{ title?: string; body?: string; state?: string }>(c);
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
  const input = await body<{ message?: string }>(c).catch(() => ({ message: undefined }));
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
    "UPDATE pulls SET state = 'merged', merge_sha = ?, merged_by = ?, updated_at = ? WHERE id = ?",
  )
    .bind(merged.sha, principal.user.id, now(), pull.id)
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
  const pull = await loadPull(c, grant);
  const input = await body<{ body?: string }>(c);
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
  const answer = await c.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
    messages: [
      {
        role: "system",
        content:
          "You review pull requests. Write 3 to 6 short plain bullet points: what changed, and anything risky. No preamble.",
      },
      { role: "user", content: `Title: ${pull.title}\n\nCommits:\n${commits}\n\nDiff:\n${diff}` },
    ],
    max_tokens: 400,
  });
  const summary =
    typeof answer === "object" && answer !== null && "response" in answer
      ? String(answer.response)
      : "";
  await c.env.DB.prepare("UPDATE pulls SET summary = ? WHERE id = ?").bind(summary, pull.id).run();
  return c.json({ summary });
});

// Collaborators.

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
  const input = await body<{ role?: Role }>(c);
  const role = input.role === "write" || input.role === "admin" ? input.role : "read";
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

function checkEnvironmentScope(principal: Principal, environment: string): void {
  if (
    principal.environment !== null &&
    principal.environment !== environment &&
    environment !== ""
  ) {
    throw new HttpError(
      403,
      `the token is limited to the ${principal.environment} environment`,
      "forbidden",
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
  const input = await body<{ name?: string; kind?: string }>(c);
  if (!isName(input.name)) {
    throw new HttpError(400, "invalid environment name", "invalid_request");
  }
  checkEnvironmentScope(principal, input.name);
  const kind = ENV_KINDS.has(input.kind ?? "") ? input.kind! : "development";
  await c.env.DB.prepare(
    "INSERT INTO environments (repo_id, name, kind, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (repo_id, name) DO UPDATE SET kind = excluded.kind",
  )
    .bind(grant.repo.id, input.name, kind, now())
    .run();
  return c.json({ name: input.name, kind }, 201);
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
  const input = await body<{ value?: string; secret?: boolean; environment?: string }>(c);
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
  if (environment !== "") {
    requireFound(
      await c.env.DB.prepare("SELECT 1 FROM environments WHERE repo_id = ? AND name = ?")
        .bind(grant.repo.id, environment)
        .first(),
      "environment",
    );
  }
  const secret = input.secret !== false;
  const value = secret
    ? await sealSecret(c.env.SECRETS_KEY, `${grant.repo.id}:${environment}:${name}`, input.value)
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
            c.env.SECRETS_KEY,
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
