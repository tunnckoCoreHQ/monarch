import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import type { View } from "../git/repo";
import { type RepoRow, type Role, roleOf, type Scope, type User, userById } from "./db";
import type { Env } from "./env";
import { HttpError, newId, now, randomToken, sha256 } from "./util";

export const SESSION_COOKIE = "wgw_session";
const SESSION_TTL = 30 * 24 * 3600;

export interface Principal {
  user: User;
  via: "session" | "token";
  scopes: Set<Scope>;
  repoId: string | null;
  environment: string | null;
  tokenId: string | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { principal: Principal | null; pendingUser: User | null };
};
export type AppContext = Context<AppEnv>;

const ALL_SCOPES: Scope[] = ["read", "write", "admin", "secrets"];
const SCOPE_NAMES = new Set<string>(ALL_SCOPES);

export function parseScopes(value: string): Set<Scope> {
  return new Set(value.split(/[\s,]+/).filter((scope): scope is Scope => SCOPE_NAMES.has(scope)));
}

interface SessionRow {
  user_id: string;
  level: "pending" | "full";
  expires_at: number;
}

export async function createSession(
  c: AppContext,
  userId: string,
  level: "pending" | "full",
): Promise<void> {
  const token = randomToken();
  await c.env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, level, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(await sha256(token), userId, level, now(), now() + SESSION_TTL)
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL,
  });
}

export async function upgradeSession(c: AppContext): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token !== undefined) {
    await c.env.DB.prepare("UPDATE sessions SET level = 'full' WHERE token_hash = ?")
      .bind(await sha256(token))
      .run();
  }
}

export async function endSession(c: AppContext): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token !== undefined) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(await sha256(token))
      .run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** Reads the bearer or basic credential. Git sends the token as the basic password. */
function credential(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  if (header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6).trim());
      return decoded.slice(decoded.indexOf(":") + 1);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

interface TokenRow {
  id: string;
  user_id: string;
  scopes: string;
  repo_id: string | null;
  environment: string | null;
  expires_at: number | null;
  last_used_at: number | null;
}

/** Resolves the caller from an API token or, when `cookie` is true, a session cookie. */
export async function authenticate(c: AppContext, { cookie }: { cookie: boolean }): Promise<void> {
  c.set("principal", null);
  c.set("pendingUser", null);
  const secret = credential(c.req.header("authorization"));
  if (secret !== undefined && secret !== "") {
    // An agent token dies with its registration, even when a grant minted it after the revoke.
    const row = await c.env.DB.prepare(
      "SELECT tokens.id, tokens.user_id, tokens.scopes, tokens.repo_id, tokens.environment, tokens.expires_at, tokens.last_used_at FROM tokens LEFT JOIN agent_registrations ON agent_registrations.id = tokens.registration_id WHERE tokens.token_hash = ? AND tokens.revoked_at IS NULL AND (tokens.registration_id IS NULL OR agent_registrations.status != 'revoked')",
    )
      .bind(await sha256(secret))
      .first<TokenRow>();
    if (row === null || (row.expires_at !== null && row.expires_at < now())) {
      throw new HttpError(401, "the token is invalid or expired", "invalid_token");
    }
    const user = await userById(c.env, row.user_id);
    if (user === null) {
      throw new HttpError(401, "the token owner no longer exists", "invalid_token");
    }
    if (row.last_used_at === null || row.last_used_at < now() - 3600) {
      c.executionCtx.waitUntil(
        c.env.DB.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?")
          .bind(now(), row.id)
          .run(),
      );
    }
    // Every key can read what its owner can read; the other scopes add to that.
    const scopes = parseScopes(row.scopes);
    scopes.add("read");
    c.set("principal", {
      user,
      via: "token",
      scopes,
      repoId: row.repo_id,
      environment: row.environment,
      tokenId: row.id,
    });
    return;
  }
  const token = cookie ? getCookie(c, SESSION_COOKIE) : undefined;
  if (token === undefined) {
    return;
  }
  const session = await c.env.DB.prepare(
    "SELECT user_id, level, expires_at FROM sessions WHERE token_hash = ?",
  )
    .bind(await sha256(token))
    .first<SessionRow>();
  if (session === null || session.expires_at < now()) {
    return;
  }
  const user = await userById(c.env, session.user_id);
  if (user === null) {
    return;
  }
  if (session.level === "pending") {
    c.set("pendingUser", user);
    return;
  }
  c.set("principal", {
    user,
    via: "session",
    scopes: new Set(ALL_SCOPES),
    repoId: null,
    environment: null,
    tokenId: null,
  });
}

export function requireUser(c: AppContext, scope: Scope = "read"): Principal {
  const principal = c.get("principal");
  if (principal === null) {
    throw new HttpError(401, "sign in or send an API token", "unauthorized");
  }
  if (!principal.scopes.has(scope)) {
    throw new HttpError(403, `the token lacks the ${scope} scope`, "insufficient_scope");
  }
  return principal;
}

const RANK: Record<Role, number> = { read: 1, write: 2, admin: 3 };

export interface Access {
  repo: RepoRow;
  role: Role | null;
  view: View;
  principal: Principal | null;
}

/** The caller's role on a repository. Private repositories look missing to outsiders. */
export async function access(c: AppContext, repo: RepoRow): Promise<Access> {
  const principal = c.get("principal");
  let role = await roleOf(c.env, repo, principal?.user ?? null);
  if (
    principal?.repoId !== null &&
    principal?.repoId !== undefined &&
    principal.repoId !== repo.id
  ) {
    role = null;
  }
  if (role === null && repo.visibility === "private") {
    throw new HttpError(404, "repository not found", "not_found");
  }
  return { repo, role, view: role === null ? "public" : "full", principal };
}

export function need(
  grant: Access,
  role: Role,
  scope: Scope = role === "read" ? "read" : role === "write" ? "write" : "admin",
): Principal {
  const principal = grant.principal;
  if (principal === null) {
    throw new HttpError(401, "sign in or send an API token", "unauthorized");
  }
  if (grant.role === null || RANK[grant.role] < RANK[role]) {
    throw new HttpError(
      403,
      `this needs ${role} access to ${grant.repo.owner}/${grant.repo.name}`,
      "forbidden",
    );
  }
  if (!principal.scopes.has(scope)) {
    throw new HttpError(403, `the token lacks the ${scope} scope`, "insufficient_scope");
  }
  return principal;
}

export interface MintedToken {
  id: string;
  token: string;
  prefix: string;
  /** The stored scopes, which always include read. */
  scopes: Scope[];
  createdAt: number;
  expiresAt: number | null;
}

interface MintOptions {
  kind: "key" | "agent";
  name: string;
  scopes: Scope[];
  repoId?: string | null;
  environment?: string | null;
  ttl?: number | null;
  registrationId?: string;
}

/**
 * Stores a new token. A token for an auth.md registration is stored only while the registration
 * is not revoked, so a grant that read the registration before a revoke gets null instead.
 */
export async function mintToken(
  env: Env,
  userId: string,
  options: MintOptions & { registrationId: string },
): Promise<MintedToken | null>;
export async function mintToken(
  env: Env,
  userId: string,
  options: MintOptions & { registrationId?: undefined },
): Promise<MintedToken>;
export async function mintToken(
  env: Env,
  userId: string,
  options: MintOptions,
): Promise<MintedToken | null> {
  const scopes = [...new Set<Scope>(["read", ...options.scopes])];
  const token = `${options.kind === "agent" ? "wgw_at" : "wgw"}_${randomToken(30)}`;
  const id = newId("tok");
  const prefix = token.slice(0, 12);
  const registrationId = options.registrationId ?? null;
  const createdAt = now();
  const expiresAt =
    options.ttl === undefined || options.ttl === null ? null : createdAt + options.ttl;
  const result = await env.DB.prepare(
    "INSERT INTO tokens (id, user_id, kind, name, prefix, token_hash, scopes, repo_id, environment, registration_id, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM agent_registrations WHERE id = ? AND status != 'revoked')",
  )
    .bind(
      id,
      userId,
      options.kind,
      options.name,
      prefix,
      await sha256(token),
      scopes.join(" "),
      options.repoId ?? null,
      options.environment ?? null,
      registrationId,
      createdAt,
      expiresAt,
      registrationId,
      registrationId,
    )
    .run();
  return result.meta.changes === 1 ? { id, token, prefix, scopes, createdAt, expiresAt } : null;
}
