import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";

import {
  type AppEnv,
  type AppContext,
  createSession,
  endSession,
  mintToken,
  parseScopes,
  type Principal,
  requireUser,
  upgradeSession,
} from "./auth";
import {
  findRepo,
  type Identity,
  publicUser,
  roleOf,
  type Scope,
  upsertUser,
  type User,
} from "./db";
import {
  base64url,
  fromBase64url,
  HttpError,
  now,
  pkceChallenge,
  randomToken,
  sha256,
} from "./util";

const TRIAD_RESOURCE = "https://triad-auth-nightly.wgw.lol/demo";
const AGENTID_ISSUER = "https://auth.agentid.com";
const agentIdKeys = createRemoteJWKSet(new URL(`${AGENTID_ISSUER}/v0/jwks.json`));
let triadKeys: ReturnType<typeof createRemoteJWKSet> | undefined;

interface LoginState {
  flow: "google" | "passkey" | "agentid";
  verifier: string;
  nonce: string;
  returnTo: string;
}

export function clientId(origin: string): string {
  return `${origin}/oauth/client.json`;
}

function safeReturn(value: string | undefined): string {
  return value !== undefined && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

async function rateLimit(c: AppContext, bucket: string): Promise<void> {
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const { success } = await c.env.LIMITER.limit({ key: `${bucket}:${ip}` });
  if (!success) {
    throw new HttpError(429, "too many requests, slow down", "rate_limited");
  }
}

// The sign-in state is bound to the browser that started it, so a captured callback URL cannot
// sign in another browser.
const STATE_COOKIE = "wgw_login";

async function saveState(
  c: AppContext,
  state: LoginState,
): Promise<{ key: string; challenge: string }> {
  const key = randomToken(24);
  await c.env.CACHE.put(`login:${key}`, JSON.stringify(state), { expirationTtl: 600 });
  setCookie(c, STATE_COOKIE, key, {
    path: "/auth",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 600,
  });
  return { key, challenge: await pkceChallenge(state.verifier) };
}

async function takeState(c: AppContext, key: string | undefined): Promise<LoginState> {
  if (key === undefined) {
    throw new HttpError(400, "the sign-in state is missing", "invalid_request");
  }
  const bound = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/auth" });
  if (bound !== key) {
    throw new HttpError(
      400,
      "this sign-in started in another browser, start again",
      "invalid_request",
    );
  }
  const state = await c.env.CACHE.get<LoginState>(`login:${key}`, "json");
  if (state === null) {
    throw new HttpError(400, "the sign-in expired, start again", "invalid_request");
  }
  await c.env.CACHE.delete(`login:${key}`);
  return state;
}

async function tokenRequest(
  url: string,
  form: Record<string, string>,
): Promise<{ id_token?: string; error?: string; error_description?: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form),
  });
  return res.json();
}

function errorPage(message: string): Response {
  const escaped = message.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><body style="font:16px monospace;background:#0b0b0b;color:#eee;padding:3rem"><h1>Sign-in failed</h1><p>${escaped}</p><p><a style="color:#d4ff3f" href="/login">Try again</a></p>`,
    {
      status: 400,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

export const login = new Hono<AppEnv>();

// The client ID metadata document Triad fetches for this app (CIMD). Triad caches it, and a
// response without a positive max-age makes Triad refuse the second fetch in one request.
login.get("/oauth/client.json", (c) => {
  const origin = c.env.ORIGIN;
  return c.json(
    {
      client_id: clientId(origin),
      client_name: "wgw git",
      client_uri: origin,
      redirect_uris: [`${origin}/auth/callback`],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid email handle name avatar cred",
    },
    200,
    { "cache-control": "public, max-age=300" },
  );
});

login.get("/auth/login", async (c) => {
  await rateLimit(c, "login");
  const flow = c.req.query("method") === "passkey" ? "passkey" : "google";
  const state: LoginState = {
    flow,
    verifier: randomToken(32),
    nonce: randomToken(16),
    returnTo: safeReturn(c.req.query("return_to")),
  };
  const { key, challenge } = await saveState(c, state);
  const url = new URL(`${c.env.TRIAD_ISSUER}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId(c.env.ORIGIN),
    redirect_uri: `${c.env.ORIGIN}/auth/callback`,
    // Passkey-only scopes make Triad refuse every Identity Source except a passkey.
    scope: flow === "passkey" ? "openid handle cred" : "openid email name avatar",
    resource: TRIAD_RESOURCE,
    state: key,
    nonce: state.nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "login",
  }).toString();
  // Triad's sign-in page reads this fragment and shows only the passkey option.
  return c.redirect(flow === "passkey" ? `${url.toString()}#provider=passkey` : url.toString());
});

login.get("/auth/callback", async (c) => {
  const error = c.req.query("error");
  if (error !== undefined) {
    return errorPage(c.req.query("error_description") ?? error);
  }
  const state = await takeState(c, c.req.query("state"));
  const issuer = c.env.TRIAD_ISSUER;
  if (c.req.query("iss") !== undefined && c.req.query("iss") !== issuer) {
    return errorPage("the response came from an unexpected issuer");
  }
  const tokens = await tokenRequest(`${issuer}/oauth2/token`, {
    grant_type: "authorization_code",
    client_id: clientId(c.env.ORIGIN),
    code: c.req.query("code") ?? "",
    redirect_uri: `${c.env.ORIGIN}/auth/callback`,
    code_verifier: state.verifier,
    resource: TRIAD_RESOURCE,
  });
  if (tokens.id_token === undefined) {
    return errorPage(tokens.error_description ?? tokens.error ?? "Triad returned no ID token");
  }
  triadKeys ??= createRemoteJWKSet(new URL(`${issuer}/jwks`));
  const { payload } = await jwtVerify(tokens.id_token, triadKeys, {
    issuer,
    audience: clientId(c.env.ORIGIN),
    algorithms: ["ES256"],
  });
  if (payload.nonce !== state.nonce || typeof payload.sub !== "string") {
    return errorPage("the ID token does not match this sign-in");
  }
  const source = String(payload.provider_sub ?? "");
  const str = (name: string): string | null => {
    const value = payload[name];
    return typeof value === "string" ? value : null;
  };
  let identity: Identity;
  if (state.flow === "google") {
    if (!source.startsWith("pid_google_")) {
      return errorPage(
        "wgw accepts Google accounts or passkey accounts. That sign-in used another provider.",
      );
    }
    const email = str("email");
    identity = {
      provider: "google",
      subject: payload.sub,
      kind: "human",
      handle: email?.split("@")[0] ?? "user",
      name: str("name") ?? "",
      email,
      avatar: str("picture"),
    };
  } else {
    if (!source.startsWith("pid_passkey_")) {
      return errorPage("That sign-in did not use a Triad passkey account.");
    }
    const username = str("preferred_username") ?? "passkey";
    identity = {
      provider: "passkey",
      subject: payload.sub,
      kind: "human",
      handle: username,
      name: username,
      email: null,
      avatar: null,
    };
  }
  const user = await upsertUser(c.env, identity);
  // Google proves the account; an app passkey is the second factor.
  await createSession(c, user.id, identity.provider === "google" ? "pending" : "full");
  const next =
    identity.provider === "google"
      ? `/login/passkey?return_to=${encodeURIComponent(state.returnTo)}`
      : state.returnTo;
  return c.redirect(next);
});

// AgentID is a plain OpenID Connect provider. An open client uses its own origin as client_id.
login.get("/auth/agentid/start", async (c) => {
  await rateLimit(c, "login");
  const state: LoginState = {
    flow: "agentid",
    verifier: randomToken(32),
    nonce: randomToken(16),
    returnTo: safeReturn(c.req.query("return_to")),
  };
  const { key, challenge } = await saveState(c, state);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: c.env.ORIGIN,
    redirect_uri: `${c.env.ORIGIN}/auth/agentid/callback`,
    scope: "openid email profile",
    state: key,
    nonce: state.nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const hint = c.req.query("login_hint");
  if (hint !== undefined && hint !== "") {
    params.set("login_hint", hint);
  }
  return c.redirect(`${AGENTID_ISSUER}/v0/authorize?${params.toString()}`);
});

login.get("/auth/agentid/callback", async (c) => {
  const error = c.req.query("error");
  if (error !== undefined) {
    return errorPage(c.req.query("error_description") ?? error);
  }
  const state = await takeState(c, c.req.query("state"));
  if (c.req.query("iss") !== undefined && c.req.query("iss") !== AGENTID_ISSUER) {
    return errorPage("the response came from an unexpected issuer");
  }
  const tokens = await tokenRequest(`${AGENTID_ISSUER}/v0/token`, {
    grant_type: "authorization_code",
    code: c.req.query("code") ?? "",
    redirect_uri: `${c.env.ORIGIN}/auth/agentid/callback`,
    client_id: c.env.ORIGIN,
    code_verifier: state.verifier,
  });
  if (tokens.id_token === undefined) {
    return errorPage(tokens.error_description ?? tokens.error ?? "AgentID returned no ID token");
  }
  const { payload } = await jwtVerify(tokens.id_token, agentIdKeys, {
    issuer: AGENTID_ISSUER,
    audience: c.env.ORIGIN,
    algorithms: ["ES256"],
  });
  if (payload.nonce !== undefined && payload.nonce !== state.nonce) {
    return errorPage("the ID token does not match this sign-in");
  }
  const str = (name: string): string | null => {
    const value = payload[name];
    return typeof value === "string" ? value : null;
  };
  const email = str("email");
  const user = await upsertUser(c.env, {
    provider: "agentid",
    subject: String(payload.sub),
    kind: "agent",
    handle: str("preferred_username") ?? email?.split("@")[0] ?? "agent",
    name: str("name") ?? email ?? "agent",
    email,
    avatar: null,
    ownerEmail: str("owner_email"),
  });
  await createSession(c, user.id, "full");
  return c.redirect(state.returnTo);
});

login.post("/auth/logout", async (c) => {
  await endSession(c);
  return c.json({ ok: true });
});

/** The person behind a browser session, full or pending. API tokens cannot manage passkeys. */
function sessionUser(c: AppContext): User {
  const principal = c.get("principal");
  if (principal !== null) {
    if (principal.via !== "session") {
      throw new HttpError(403, "manage passkeys in the browser", "forbidden");
    }
    return principal.user;
  }
  const pending = c.get("pendingUser");
  if (pending === null) {
    throw new HttpError(401, "sign in first", "unauthorized");
  }
  return pending;
}

/** Key management needs a session or a key without repository or environment limits. */
function accountPrincipal(c: AppContext): Principal {
  const principal = requireUser(c, "admin");
  if (principal.repoId !== null || principal.environment !== null) {
    throw new HttpError(403, "a limited key cannot manage keys", "forbidden");
  }
  return principal;
}

function rp(c: AppContext): { rpID: string; origin: string } {
  return { rpID: new URL(c.env.ORIGIN).hostname, origin: c.env.ORIGIN };
}

interface PasskeyRow {
  id: string;
  public_key: string;
  counter: number;
  transports: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

async function passkeysOf(c: AppContext, userId: string): Promise<PasskeyRow[]> {
  const result = await c.env.DB.prepare(
    "SELECT id, public_key, counter, transports, name, created_at, last_used_at FROM passkeys WHERE user_id = ?",
  )
    .bind(userId)
    .all<PasskeyRow>();
  return result.results;
}

login.get("/api/auth/state", async (c) => {
  const principal = c.get("principal");
  const user = principal?.user ?? c.get("pendingUser");
  if (user === null || user === undefined) {
    return c.json({ level: "none" });
  }
  const passkeys = await passkeysOf(c, user.id);
  return c.json({
    level: principal === null ? "pending" : "full",
    user: publicUser(user),
    passkeys: passkeys.map((key) => ({
      id: key.id,
      name: key.name,
      created_at: key.created_at,
      last_used_at: key.last_used_at,
    })),
  });
});

login.post("/api/auth/passkey/register/options", async (c) => {
  const user = sessionUser(c);
  const existing = await passkeysOf(c, user.id);
  // A pending session may add a passkey only when the account has none yet.
  if (c.get("principal") === null && existing.length > 0) {
    throw new HttpError(403, "verify with an existing passkey first", "forbidden");
  }
  const { rpID } = rp(c);
  const options = await generateRegistrationOptions({
    rpName: "wgw",
    rpID,
    userName: user.handle,
    userDisplayName: user.name || user.handle,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing.map((key) => ({ id: key.id })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  await c.env.CACHE.put(`webauthn:${user.id}`, options.challenge, { expirationTtl: 300 });
  return c.json(options);
});

login.post("/api/auth/passkey/register/verify", async (c) => {
  const user = sessionUser(c);
  const body = await c.req.json<{
    response: Parameters<typeof verifyRegistrationResponse>[0]["response"];
    name?: string;
  }>();
  const challenge = await c.env.CACHE.get(`webauthn:${user.id}`);
  if (challenge === null) {
    throw new HttpError(400, "the passkey challenge expired", "invalid_request");
  }
  await c.env.CACHE.delete(`webauthn:${user.id}`);
  const existing = await passkeysOf(c, user.id);
  if (c.get("principal") === null && existing.length > 0) {
    throw new HttpError(403, "verify with an existing passkey first", "forbidden");
  }
  const { rpID, origin } = rp(c);
  const result = await verifyRegistrationResponse({
    response: body.response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!result.verified) {
    throw new HttpError(400, "the passkey could not be verified", "invalid_request");
  }
  const credential = result.registrationInfo.credential;
  await c.env.DB.prepare(
    "INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      credential.id,
      user.id,
      base64url(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      body.name?.slice(0, 60) || "passkey",
      now(),
    )
    .run();
  await upgradeSession(c);
  return c.json({ ok: true });
});

login.post("/api/auth/passkey/authenticate/options", async (c) => {
  const user = sessionUser(c);
  const keys = await passkeysOf(c, user.id);
  if (keys.length === 0) {
    throw new HttpError(400, "the account has no passkey yet", "invalid_request");
  }
  const options = await generateAuthenticationOptions({
    rpID: rp(c).rpID,
    allowCredentials: keys.map((key) => ({ id: key.id, transports: JSON.parse(key.transports) })),
    userVerification: "required",
  });
  await c.env.CACHE.put(`webauthn:${user.id}`, options.challenge, { expirationTtl: 300 });
  return c.json(options);
});

login.post("/api/auth/passkey/authenticate/verify", async (c) => {
  const user = sessionUser(c);
  const body = await c.req.json<{
    response: Parameters<typeof verifyAuthenticationResponse>[0]["response"];
  }>();
  const challenge = await c.env.CACHE.get(`webauthn:${user.id}`);
  if (challenge === null) {
    throw new HttpError(400, "the passkey challenge expired", "invalid_request");
  }
  await c.env.CACHE.delete(`webauthn:${user.id}`);
  const key = (await passkeysOf(c, user.id)).find((item) => item.id === body.response.id);
  if (key === undefined) {
    throw new HttpError(400, "that passkey does not belong to this account", "invalid_request");
  }
  const { rpID, origin } = rp(c);
  const result = await verifyAuthenticationResponse({
    response: body.response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: key.id,
      publicKey: fromBase64url(key.public_key),
      counter: key.counter,
      transports: JSON.parse(key.transports),
    },
    requireUserVerification: true,
  });
  if (!result.verified) {
    throw new HttpError(400, "the passkey could not be verified", "invalid_request");
  }
  await c.env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?")
    .bind(result.authenticationInfo.newCounter, now(), key.id)
    .run();
  await upgradeSession(c);
  return c.json({ ok: true });
});

login.delete("/api/auth/passkeys/:id", async (c) => {
  const principal = requireUser(c, "admin");
  if (principal.via !== "session") {
    throw new HttpError(403, "manage passkeys in the browser", "forbidden");
  }
  const keys = await passkeysOf(c, principal.user.id);
  if (principal.user.provider === "google" && keys.length <= 1) {
    throw new HttpError(400, "Google accounts keep at least one passkey", "invalid_request");
  }
  await c.env.DB.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), principal.user.id)
    .run();
  return c.json({ ok: true });
});

login.get("/api/me", (c) => {
  const principal = requireUser(c);
  return c.json({
    ...publicUser(principal.user),
    email: principal.user.email,
    via: principal.via,
    scopes: [...principal.scopes],
  });
});

// Device flow for the CLI: the CLI shows a code, a signed-in browser approves it, and the CLI
// receives a new API key.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

function userCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

login.post("/api/device/code", async (c) => {
  await rateLimit(c, "device");
  const body = await c.req
    .json<{ client_name?: string }>()
    .catch(() => ({ client_name: undefined }));
  const deviceCode = randomToken(32);
  const code = userCode();
  await c.env.DB.prepare(
    "INSERT INTO device_codes (code_hash, user_code, client_name, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)",
  )
    .bind(
      await sha256(deviceCode),
      code,
      (body.client_name ?? "wgw cli").slice(0, 80),
      now(),
      now() + 600,
    )
    .run();
  return c.json({
    device_code: deviceCode,
    user_code: code,
    verification_uri: `${c.env.ORIGIN}/device`,
    verification_uri_complete: `${c.env.ORIGIN}/device?code=${code}`,
    expires_in: 600,
    interval: 5,
  });
});

interface DeviceRow {
  code_hash: string;
  user_code: string;
  client_name: string;
  status: "pending" | "approved" | "denied" | "used";
  user_id: string | null;
  expires_at: number;
  polled_at: number | null;
}

login.post("/api/device/token", async (c) => {
  const body = await c.req.json<{ device_code?: string }>();
  const hash = await sha256(body.device_code ?? "");
  const row = await c.env.DB.prepare("SELECT * FROM device_codes WHERE code_hash = ?")
    .bind(hash)
    .first<DeviceRow>();
  if (row === null) {
    return c.json({ error: "invalid_grant" }, 400);
  }
  if (row.expires_at < now()) {
    return c.json({ error: "expired_token" }, 400);
  }
  if (row.polled_at !== null && row.polled_at > now() - 4) {
    return c.json({ error: "slow_down" }, 400);
  }
  await c.env.DB.prepare("UPDATE device_codes SET polled_at = ? WHERE code_hash = ?")
    .bind(now(), hash)
    .run();
  if (row.status === "pending") {
    return c.json({ error: "authorization_pending" }, 400);
  }
  if (row.status !== "approved" || row.user_id === null) {
    return c.json({ error: "access_denied" }, 400);
  }
  const claimed = await c.env.DB.prepare(
    "UPDATE device_codes SET status = 'used' WHERE code_hash = ? AND status = 'approved'",
  )
    .bind(hash)
    .run();
  if (claimed.meta.changes !== 1) {
    return c.json({ error: "invalid_grant" }, 400);
  }
  const scopes: Scope[] = ["read", "write", "admin", "secrets"];
  const minted = await mintToken(c.env, row.user_id, {
    kind: "key",
    name: row.client_name,
    scopes,
    ttl: 90 * 24 * 3600,
  });
  return c.json({ token: minted.token, token_id: minted.id, scopes });
});

login.get("/api/device/:code", async (c) => {
  requireUser(c, "admin");
  const row = await c.env.DB.prepare("SELECT * FROM device_codes WHERE user_code = ?")
    .bind(c.req.param("code").toUpperCase())
    .first<DeviceRow>();
  if (row === null || row.expires_at < now()) {
    throw new HttpError(404, "unknown or expired code", "not_found");
  }
  return c.json({ user_code: row.user_code, client_name: row.client_name, status: row.status });
});

login.post("/api/device/:code", async (c) => {
  const principal = requireUser(c, "admin");
  if (principal.via !== "session") {
    throw new HttpError(403, "approve device codes in the browser", "forbidden");
  }
  const body = await c.req.json<{ approve?: boolean }>();
  const result = await c.env.DB.prepare(
    "UPDATE device_codes SET status = ?, user_id = ? WHERE user_code = ? AND status = 'pending' AND expires_at > ?",
  )
    .bind(
      body.approve === false ? "denied" : "approved",
      principal.user.id,
      c.req.param("code").toUpperCase(),
      now(),
    )
    .run();
  if (result.meta.changes !== 1) {
    throw new HttpError(404, "unknown, used, or expired code", "not_found");
  }
  return c.json({ ok: true });
});

interface KeyRow {
  id: string;
  name: string;
  kind: string;
  prefix: string;
  scopes: string;
  repo_id: string | null;
  /** owner/name of the repository the key is limited to; null when it has none or it is gone. */
  repo: string | null;
  environment: string | null;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
}

login.get("/api/keys", async (c) => {
  const principal = accountPrincipal(c);
  const result = await c.env.DB.prepare(
    "SELECT tokens.id, tokens.name, tokens.kind, tokens.prefix, tokens.scopes, tokens.repo_id, owners.handle || '/' || repos.name AS repo, tokens.environment, tokens.created_at, tokens.expires_at, tokens.last_used_at FROM tokens LEFT JOIN repos ON repos.id = tokens.repo_id LEFT JOIN users AS owners ON owners.id = repos.owner_id WHERE tokens.user_id = ? AND tokens.revoked_at IS NULL AND (tokens.expires_at IS NULL OR tokens.expires_at > ?) ORDER BY tokens.created_at DESC",
  )
    .bind(principal.user.id, now())
    .all<KeyRow>();
  return c.json(result.results.map((row) => ({ ...row, scopes: row.scopes.split(" ") })));
});

login.post("/api/keys", async (c) => {
  const principal = accountPrincipal(c);
  const body = await c.req.json<{
    name?: string;
    scopes?: string[];
    repo?: string;
    environment?: string;
    expires_in_days?: number;
  }>();
  const scopes = [...parseScopes((body.scopes ?? ["read", "write"]).join(" "))].filter((scope) =>
    principal.scopes.has(scope),
  );
  if (scopes.length === 0) {
    throw new HttpError(
      400,
      "pick at least one scope: read, write, admin, secrets",
      "invalid_request",
    );
  }
  let repoId: string | null = null;
  if (body.repo !== undefined && body.repo !== "") {
    const [owner, name] = body.repo.split("/");
    const repo = await findRepo(c.env, owner ?? "", name ?? "");
    if (repo === null || (await roleOf(c.env, repo, principal.user)) === null) {
      throw new HttpError(404, "repository not found", "not_found");
    }
    repoId = repo.id;
  }
  const days = body.expires_in_days ?? 90;
  const minted = await mintToken(c.env, principal.user.id, {
    kind: "key",
    name: (body.name ?? "api key").slice(0, 80),
    scopes,
    repoId,
    environment: body.environment ?? null,
    ttl: days > 0 ? days * 24 * 3600 : null,
  });
  return c.json(
    { id: minted.id, token: minted.token, prefix: minted.prefix, scopes, repo_id: repoId },
    201,
  );
});

login.delete("/api/keys/:id", async (c) => {
  const principal = accountPrincipal(c);
  await c.env.DB.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND user_id = ?")
    .bind(now(), c.req.param("id"), principal.user.id)
    .run();
  return c.json({ ok: true });
});
