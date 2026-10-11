import type { Env } from "./env";
import { HttpError, newId, now, toHandle } from "./util";

export type Provider = "google" | "passkey" | "agentid" | "authmd";
export type Role = "read" | "write" | "admin";
export type Scope = "read" | "write" | "admin" | "secrets";

export interface User {
  id: string;
  handle: string;
  name: string;
  email: string | null;
  avatar: string | null;
  kind: "human" | "agent";
  provider: Provider;
  subject: string;
  owner_email: string | null;
  created_at: number;
}

export interface RepoRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  visibility: "public" | "private";
  default_branch: string;
  source: string | null;
  forked_from: string | null;
  pushed_at: number | null;
  created_at: number;
  owner: string;
  status: "ready" | "importing" | "forking" | "failed";
  status_detail: string | null;
}

export function publicUser(user: User) {
  return {
    id: user.id,
    handle: user.handle,
    name: user.name,
    avatar: user.avatar,
    kind: user.kind,
    provider: user.provider,
  };
}

export function repoJson(repo: RepoRow, origin: string) {
  return {
    id: repo.id,
    owner: repo.owner,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    description: repo.description,
    visibility: repo.visibility,
    default_branch: repo.default_branch,
    source: repo.source,
    forked_from: repo.forked_from,
    pushed_at: repo.pushed_at,
    created_at: repo.created_at,
    clone_url: `${origin}/${repo.owner}/${repo.name}.git`,
    web_url: `${origin}/${repo.owner}/${repo.name}`,
    status: repo.status,
    status_detail: repo.status_detail,
    storage: "artifacts",
  };
}

const REPO_SELECT =
  "SELECT repos.*, users.handle AS owner FROM repos JOIN users ON users.id = repos.owner_id";

export async function findRepo(env: Env, owner: string, name: string): Promise<RepoRow | null> {
  return env.DB.prepare(`${REPO_SELECT} WHERE users.handle = ? AND repos.name = ?`)
    .bind(owner.toLowerCase(), name)
    .first<RepoRow>();
}

export async function findRepoById(env: Env, id: string): Promise<RepoRow | null> {
  return env.DB.prepare(`${REPO_SELECT} WHERE repos.id = ?`).bind(id).first<RepoRow>();
}

/** Public repositories, plus private ones the viewer can read. */
export async function listRepos(env: Env, viewer: User | null, owner?: string): Promise<RepoRow[]> {
  const viewerId = viewer?.id ?? "";
  const where = [
    "(repos.visibility = 'public' OR repos.owner_id = ?1 OR EXISTS (SELECT 1 FROM collaborators c WHERE c.repo_id = repos.id AND c.user_id = ?1))",
  ];
  const binds: string[] = [viewerId];
  if (owner !== undefined) {
    where.push("users.handle = ?2");
    binds.push(owner.toLowerCase());
  }
  const result = await env.DB.prepare(
    `${REPO_SELECT} WHERE ${where.join(" AND ")} ORDER BY COALESCE(repos.pushed_at, repos.created_at) DESC LIMIT 200`,
  )
    .bind(...binds)
    .all<RepoRow>();
  return result.results;
}

export async function roleOf(env: Env, repo: RepoRow, user: User | null): Promise<Role | null> {
  if (user === null) {
    return null;
  }
  if (repo.owner_id === user.id) {
    return "admin";
  }
  const row = await env.DB.prepare(
    "SELECT role FROM collaborators WHERE repo_id = ? AND user_id = ?",
  )
    .bind(repo.id, user.id)
    .first<{ role: Role }>();
  return row?.role ?? null;
}

export async function userByHandle(env: Env, handle: string): Promise<User | null> {
  return env.DB.prepare("SELECT * FROM users WHERE handle = ?")
    .bind(handle.toLowerCase())
    .first<User>();
}

export async function userById(env: Env, id: string): Promise<User | null> {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
}

export interface Identity {
  provider: Provider;
  subject: string;
  kind: "human" | "agent";
  handle: string;
  name: string;
  email: string | null;
  avatar: string | null;
  ownerEmail?: string | null;
}

/** Finds the account for an identity or creates it with a free handle. Profile fields refresh. */
export async function upsertUser(env: Env, identity: Identity): Promise<User> {
  const existing = await env.DB.prepare("SELECT * FROM users WHERE provider = ? AND subject = ?")
    .bind(identity.provider, identity.subject)
    .first<User>();
  if (existing !== null) {
    await env.DB.prepare(
      "UPDATE users SET name = ?, email = COALESCE(?, email), avatar = COALESCE(?, avatar), owner_email = COALESCE(?, owner_email) WHERE id = ?",
    )
      .bind(
        identity.name || existing.name,
        identity.email,
        identity.avatar,
        identity.ownerEmail ?? null,
        existing.id,
      )
      .run();
    return (await userById(env, existing.id))!;
  }
  const base = toHandle(identity.handle);
  let handle = base;
  for (let i = 2; (await userByHandle(env, handle)) !== null || RESERVED.has(handle); i++) {
    handle = `${base.slice(0, 35)}-${i}`;
  }
  const id = newId("usr");
  await env.DB.prepare(
    "INSERT INTO users (id, handle, name, email, avatar, kind, provider, subject, owner_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      handle,
      identity.name,
      identity.email,
      identity.avatar,
      identity.kind,
      identity.provider,
      identity.subject,
      identity.ownerEmail ?? null,
      now(),
    )
    .run();
  return (await userById(env, id))!;
}

/** Handles that collide with top-level routes. */
export const RESERVED = new Set([
  "api",
  "auth",
  "oauth",
  "oauth2",
  "agent",
  "login",
  "logout",
  "new",
  "settings",
  "device",
  "claim",
  "explore",
  "mcp",
  "docs",
  "about",
  "admin",
  "assets",
  "static",
  "skill.md",
  "auth.md",
  "llms.txt",
  "install.sh",
  "wgw.mjs",
]);

export async function recordEvent(
  env: Env,
  repoId: string,
  actorId: string | null,
  type: string,
  data: unknown,
): Promise<void> {
  await eventStatement(env, newId("evt"), repoId, actorId, type, data).run();
}

/** An event insert that does nothing when the id exists, so a retried record is not doubled. */
export function eventStatement(
  env: Env,
  id: string,
  repoId: string,
  actorId: string | null,
  type: string,
  data: unknown,
): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO events (id, repo_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
  ).bind(id, repoId, actorId, type, JSON.stringify(data), now());
}

export function requireFound<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new HttpError(404, `${what} not found`, "not_found");
  }
  return value;
}
