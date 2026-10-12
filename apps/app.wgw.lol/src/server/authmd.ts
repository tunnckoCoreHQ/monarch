import { Hono } from "hono";
import {
  calculateJwkThumbprint,
  exportJWK,
  importJWK,
  importPKCS8,
  type JWK,
  jwtVerify,
  SignJWT,
} from "jose";

import { type AppContext, type AppEnv, mintToken, requireUser } from "./auth";
import { type Scope, upsertUser } from "./db";
import type { Env } from "./env";
import { HttpError, newId, now, randomToken, readJson, sha256 } from "./util";

// auth.md (https://workos.com/auth-md): an agent registers, a person claims the registration with
// a six-digit code, and the agent trades the signed identity assertion for short-lived tokens.

const PRE_CLAIM_SCOPES: Scope[] = ["read"];
const POST_CLAIM_SCOPES: Scope[] = ["read", "write"];
const ACCESS_TTL = 3600;
const CODE_TTL = 600;
const CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim";
const JWT_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

let signing: Promise<{ key: CryptoKey; jwk: JWK }> | undefined;

function signingKey(env: Env) {
  signing ??= (async () => {
    // Secrets Store holds the PEM; the binding reads it with get().
    const key = await importPKCS8(await env.SIGNING_KEY.get(), "ES256", { extractable: true });
    const { d: _private, ...jwk } = await exportJWK(key);
    const kid = await calculateJwkThumbprint(jwk);
    return { key, jwk: { ...jwk, kid, alg: "ES256", use: "sig" } };
  })().catch((error: unknown) => {
    // A failed read must not stick; the next request tries again.
    signing = undefined;
    throw error;
  });
  return signing;
}

async function assertion(env: Env, registrationId: string, scopes: string[], ttl: number) {
  const { key, jwk } = await signingKey(env);
  const expires = now() + ttl;
  const token = await new SignJWT({ scope: scopes.join(" ") })
    .setProtectedHeader({ alg: "ES256", typ: "oauth-id-jag+jwt", kid: jwk.kid })
    .setIssuer(env.ORIGIN)
    .setAudience(env.ORIGIN)
    .setSubject(registrationId)
    .setIssuedAt()
    .setExpirationTime(expires)
    .setJti(randomToken(12))
    .sign(key);
  return { token, expires: new Date(expires * 1000).toISOString() };
}

function oauthError(
  c: AppContext,
  error: string,
  description: string,
  status: 400 | 401 | 429 = 400,
) {
  return c.json({ error, error_description: description }, status, { "cache-control": "no-store" });
}

async function limit(c: AppContext, bucket: string): Promise<boolean> {
  const { success } = await c.env.LIMITER.limit({
    key: `${bucket}:${c.req.header("cf-connecting-ip") ?? "local"}`,
  });
  return success;
}

function sixDigits(): string {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return value.toString().padStart(6, "0");
}

interface Registration {
  id: string;
  type: "anonymous" | "service_auth";
  status: "unclaimed" | "claiming" | "claimed" | "revoked";
  claim_email: string | null;
  code_expires_at: number | null;
  user_id: string | null;
  expires_at: number;
  polled_at: number | null;
}

async function startClaim(c: AppContext, registrationId: string) {
  const attempt = `cat_${randomToken(24)}`;
  const code = sixDigits();
  await c.env.DB.prepare(
    "UPDATE agent_registrations SET status = 'claiming', attempt_token_hash = ?, user_code_hash = ?, code_expires_at = ? WHERE id = ?",
  )
    .bind(await sha256(attempt), await sha256(code), now() + CODE_TTL, registrationId)
    .run();
  return {
    user_code: code,
    expires_in: CODE_TTL,
    verification_uri: `${c.env.ORIGIN}/claim?attempt=${attempt}`,
    interval: 5,
  };
}

/**
 * The statements that revoke a registration that `userId` claimed, and every token it holds. Each
 * grant refuses a revoked registration, so the agent cannot get new tokens with its claim token or
 * assertion. Run them in one batch, which D1 applies as a transaction.
 */
export function registrationRevokes(env: Env, id: string, userId: string): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      "UPDATE agent_registrations SET status = 'revoked' WHERE id = ? AND user_id = ?",
    ).bind(id, userId),
    env.DB.prepare(
      "UPDATE tokens SET revoked_at = ? WHERE registration_id = ? AND user_id = ? AND revoked_at IS NULL",
    ).bind(now(), id, userId),
  ];
}

export const authmd = new Hono<AppEnv>();

authmd.get("/.well-known/oauth-protected-resource", (c) =>
  c.json({
    resource: `${c.env.ORIGIN}/`,
    resource_name: "wgw",
    resource_documentation: `${c.env.ORIGIN}/skill.md`,
    authorization_servers: [c.env.ORIGIN],
    scopes_supported: ["read", "write", "admin", "secrets"],
    bearer_methods_supported: ["header"],
  }),
);

authmd.get("/.well-known/oauth-authorization-server", (c) => {
  const origin = c.env.ORIGIN;
  return c.json({
    issuer: origin,
    token_endpoint: `${origin}/oauth2/token`,
    revocation_endpoint: `${origin}/oauth2/revoke`,
    jwks_uri: `${origin}/.well-known/jwks.json`,
    grant_types_supported: [JWT_GRANT, CLAIM_GRANT],
    scopes_supported: ["read", "write"],
    agent_auth: {
      skill: `${origin}/auth.md`,
      identity_endpoint: `${origin}/agent/identity`,
      claim_endpoint: `${origin}/agent/identity/claim`,
      identity_types_supported: ["anonymous", "service_auth"],
    },
  });
});

authmd.get("/.well-known/jwks.json", async (c) => {
  const { jwk } = await signingKey(c.env);
  return c.json({ keys: [jwk] }, 200, { "cache-control": "public, max-age=3600" });
});

authmd.post("/agent/identity", async (c) => {
  if (!(await limit(c, "authmd"))) {
    return oauthError(c, "rate_limited", "too many registrations from this address", 429);
  }
  const input = await c.req
    .json<{ type?: string; login_hint?: string }>()
    .catch(() => ({ type: undefined, login_hint: undefined }));
  const id = newId("reg");
  const claimToken = `clm_${randomToken(24)}`;
  const claimUrl = `${c.env.ORIGIN}/agent/identity/claim`;
  if (input.type === "anonymous") {
    // Every registration gets its own agent account; it can read public repositories until claimed.
    const agent = await upsertUser(c.env, {
      provider: "authmd",
      subject: id,
      kind: "agent",
      handle: `agent-${id.slice(4, 12)}`,
      name: "unclaimed agent",
      email: null,
      avatar: null,
    });
    await c.env.DB.prepare(
      "INSERT INTO agent_registrations (id, type, status, claim_token_hash, user_id, created_at, expires_at) VALUES (?, 'anonymous', 'unclaimed', ?, ?, ?, ?)",
    )
      .bind(id, await sha256(claimToken), agent.id, now(), now() + 30 * 86_400)
      .run();
    const signed = await assertion(c.env, id, PRE_CLAIM_SCOPES, 86_400);
    return c.json({
      registration_id: id,
      registration_type: "anonymous",
      identity_assertion: signed.token,
      assertion_expires: signed.expires,
      pre_claim_scopes: PRE_CLAIM_SCOPES,
      claim_url: claimUrl,
      claim_token: claimToken,
      claim_token_expires: new Date((now() + 30 * 86_400) * 1000).toISOString(),
      post_claim_scopes: POST_CLAIM_SCOPES,
    });
  }
  if (input.type === "service_auth") {
    const hint = (typeof input.login_hint === "string" ? input.login_hint : "")
      .trim()
      .toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(hint) && !/^@[a-z0-9-]{1,39}$/.test(hint)) {
      return oauthError(
        c,
        "invalid_login_hint",
        "login_hint must be an email address or an @handle",
      );
    }
    await c.env.DB.prepare(
      "INSERT INTO agent_registrations (id, type, status, claim_token_hash, claim_email, created_at, expires_at) VALUES (?, 'service_auth', 'unclaimed', ?, ?, ?, ?)",
    )
      .bind(id, await sha256(claimToken), hint, now(), now() + 86_400)
      .run();
    return c.json({
      registration_id: id,
      registration_type: "service_auth",
      claim_url: claimUrl,
      claim_token: claimToken,
      claim_token_expires: new Date((now() + 86_400) * 1000).toISOString(),
      post_claim_scopes: POST_CLAIM_SCOPES,
      claim: await startClaim(c, id),
    });
  }
  if (input.type === "identity_assertion") {
    return oauthError(
      c,
      "issuer_not_enabled",
      "no agent providers are trusted yet; use anonymous or service_auth",
    );
  }
  return oauthError(c, "invalid_request", "type must be anonymous or service_auth");
});

async function registrationByClaim(
  env: Env,
  claimToken: string | undefined,
): Promise<Registration | null> {
  if (claimToken === undefined || claimToken === "") {
    return null;
  }
  return env.DB.prepare("SELECT * FROM agent_registrations WHERE claim_token_hash = ?")
    .bind(await sha256(claimToken))
    .first<Registration>();
}

authmd.post("/agent/identity/claim", async (c) => {
  const input = await c.req
    .json<{ claim_token?: string; email?: string }>()
    .catch(() => ({ claim_token: undefined, email: undefined }));
  const registration = await registrationByClaim(c.env, input.claim_token);
  if (registration === null || registration.expires_at < now()) {
    return oauthError(c, "invalid_claim_token", "unknown or expired claim token");
  }
  if (registration.status === "revoked") {
    return oauthError(c, "invalid_claim_token", "the person who claimed this agent revoked it");
  }
  if (registration.status === "claimed") {
    return oauthError(c, "claimed_or_in_flight", "this registration is already claimed");
  }
  if (typeof (input.email ?? "") !== "string") {
    return oauthError(c, "invalid_request", "email must be a string");
  }
  const email = (input.email ?? registration.claim_email ?? "").trim().toLowerCase();
  if (email === "") {
    return oauthError(
      c,
      "invalid_request",
      "send the email (or @handle) of the person who will claim this agent",
    );
  }
  await c.env.DB.prepare("UPDATE agent_registrations SET claim_email = ? WHERE id = ?")
    .bind(email, registration.id)
    .run();
  const attempt = await startClaim(c, registration.id);
  return c.json({
    registration_id: registration.id,
    claim_attempt_id: newId("att"),
    status: "initiated",
    expires_at: new Date((now() + CODE_TTL) * 1000).toISOString(),
    claim_attempt: attempt,
  });
});

// The claim page calls these two with the signed-in person's session.
authmd.get("/api/claims/:attempt", async (c) => {
  requireUser(c, "admin");
  const row = await c.env.DB.prepare(
    "SELECT id, type, status, claim_email, code_expires_at FROM agent_registrations WHERE attempt_token_hash = ?",
  )
    .bind(await sha256(c.req.param("attempt")))
    .first<Registration>();
  if (row === null) {
    throw new HttpError(404, "unknown claim link", "not_found");
  }
  return c.json({
    registration_id: row.id,
    type: row.type,
    status: row.status,
    claim_email: row.claim_email,
    expired: (row.code_expires_at ?? 0) < now(),
    scopes: POST_CLAIM_SCOPES,
  });
});

authmd.post("/api/claims/:attempt", async (c) => {
  const principal = requireUser(c, "admin");
  if (principal.via !== "session" || principal.user.kind !== "human") {
    throw new HttpError(403, "a person claims agents from a browser session", "forbidden");
  }
  const input = await readJson<{ user_code?: string }>(c, { user_code: "string" });
  const row = await c.env.DB.prepare(
    "SELECT * FROM agent_registrations WHERE attempt_token_hash = ?",
  )
    .bind(await sha256(c.req.param("attempt")))
    .first<Registration & { user_code_hash: string }>();
  if (row === null || row.status !== "claiming") {
    throw new HttpError(404, "unknown or finished claim", "not_found");
  }
  if ((row.code_expires_at ?? 0) < now()) {
    throw new HttpError(400, "the code expired; ask the agent for a new one", "expired");
  }
  const who = row.claim_email ?? "";
  const matches = who.startsWith("@")
    ? who.slice(1) === principal.user.handle
    : who === (principal.user.email ?? "").toLowerCase();
  if (!matches) {
    throw new HttpError(
      403,
      `this claim is for ${who}; you are signed in as ${principal.user.email ?? `@${principal.user.handle}`}`,
      "forbidden",
    );
  }
  if ((await sha256((input.user_code ?? "").trim())) !== row.user_code_hash) {
    throw new HttpError(400, "wrong code", "invalid_code");
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE agent_registrations SET status = 'claimed', user_id = ?, expires_at = ? WHERE id = ?",
    ).bind(principal.user.id, now() + 180 * 86_400, row.id),
    // Claiming ends the pre-claim tokens of an anonymous registration.
    c.env.DB.prepare(
      "UPDATE tokens SET revoked_at = ? WHERE registration_id = ? AND revoked_at IS NULL",
    ).bind(now(), row.id),
  ]);
  return c.json({ ok: true, registration_id: row.id });
});

authmd.post("/oauth2/token", async (c) => {
  const form = await c.req.parseBody();
  const grant = String(form.grant_type ?? "");
  if (grant === CLAIM_GRANT) {
    const registration = await registrationByClaim(c.env, String(form.claim_token ?? ""));
    if (registration === null || registration.expires_at < now()) {
      return oauthError(c, "invalid_grant", "unknown or expired claim token");
    }
    if (registration.status === "revoked") {
      return oauthError(c, "invalid_grant", "the person who claimed this agent revoked it");
    }
    if (registration.polled_at !== null && registration.polled_at > now() - 4) {
      await c.env.DB.prepare("UPDATE agent_registrations SET polled_at = ? WHERE id = ?")
        .bind(now(), registration.id)
        .run();
      return oauthError(c, "slow_down", "poll every 5 seconds");
    }
    await c.env.DB.prepare("UPDATE agent_registrations SET polled_at = ? WHERE id = ?")
      .bind(now(), registration.id)
      .run();
    if (registration.status !== "claimed") {
      if (registration.status === "claiming" && (registration.code_expires_at ?? 0) < now()) {
        return oauthError(c, "expired_token", "the code expired; call the claim endpoint again");
      }
      return oauthError(c, "authorization_pending", "waiting for a person to enter the code");
    }
    const signed = await assertion(c.env, registration.id, POST_CLAIM_SCOPES, 30 * 86_400);
    const access = await mintToken(c.env, registration.user_id!, {
      kind: "agent",
      name: `auth.md ${registration.id}`,
      scopes: ["read", "write"],
      ttl: ACCESS_TTL,
      registrationId: registration.id,
    });
    if (access === null) {
      return oauthError(c, "invalid_grant", "the person who claimed this agent revoked it");
    }
    return c.json(
      {
        access_token: access.token,
        token_type: "Bearer",
        expires_in: ACCESS_TTL,
        scope: POST_CLAIM_SCOPES.join(" "),
        identity_assertion: signed.token,
        assertion_expires: signed.expires,
      },
      200,
      { "cache-control": "no-store" },
    );
  }
  if (grant === JWT_GRANT) {
    const { jwk } = await signingKey(c.env);
    let subject: string;
    try {
      const { payload } = await jwtVerify(
        String(form.assertion ?? ""),
        await importJWK(jwk, "ES256"),
        {
          issuer: c.env.ORIGIN,
          audience: c.env.ORIGIN,
          typ: "oauth-id-jag+jwt",
        },
      );
      subject = String(payload.sub);
    } catch {
      return oauthError(c, "invalid_grant", "the identity assertion is invalid or expired");
    }
    const registration = await c.env.DB.prepare("SELECT * FROM agent_registrations WHERE id = ?")
      .bind(subject)
      .first<Registration>();
    if (
      registration === null ||
      registration.status === "revoked" ||
      registration.user_id === null ||
      registration.expires_at < now()
    ) {
      return oauthError(c, "invalid_grant", "the registration is gone; register again");
    }
    const claimed = registration.status === "claimed";
    const scopes = claimed ? POST_CLAIM_SCOPES : PRE_CLAIM_SCOPES;
    const access = await mintToken(c.env, registration.user_id, {
      kind: "agent",
      name: `auth.md ${registration.id}`,
      scopes,
      ttl: ACCESS_TTL,
      registrationId: registration.id,
    });
    if (access === null) {
      return oauthError(c, "invalid_grant", "the registration is gone; register again");
    }
    return c.json(
      {
        access_token: access.token,
        token_type: "Bearer",
        expires_in: ACCESS_TTL,
        scope: scopes.join(" "),
      },
      200,
      { "cache-control": "no-store" },
    );
  }
  return oauthError(c, "unsupported_grant_type", `use ${CLAIM_GRANT} or ${JWT_GRANT}`);
});

authmd.post("/oauth2/revoke", async (c) => {
  const form = await c.req.parseBody();
  const token = String(form.token ?? "");
  if (token !== "") {
    await c.env.DB.prepare(
      "UPDATE tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
    )
      .bind(now(), await sha256(token))
      .run();
  }
  return c.body(null, 200);
});
