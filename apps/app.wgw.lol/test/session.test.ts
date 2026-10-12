import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/server/app";
import { SESSION_COOKIE } from "../src/server/auth";
import type { Env } from "../src/server/env";
import { sha256 } from "../src/server/util";
import { fakeD1 } from "./memory";

let env: Env;

beforeEach(async () => {
  const db = fakeD1();
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- authentication reads only D1.
  env = { DB: db } as unknown as Env;
  await db
    .prepare(
      "INSERT INTO users (id, handle, name, kind, provider, subject, created_at) VALUES ('usr_alice', 'alice', 'Alice', 'human', 'google', 'alice', 0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, level, created_at, expires_at) VALUES (?, 'usr_alice', 'full', 0, 4102444800)",
    )
    .bind(await sha256("alice-session"))
    .run();
});

describe("GET /api/session", () => {
  it("answers a signed-out caller with a 200 and no user, while /api/me keeps its 401", async () => {
    const session = await app.request("/api/session", {}, env);
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ me: null });
    expect((await app.request("/api/me", {}, env)).status).toBe(401);
  });

  it("returns the same user as /api/me for a signed-in caller", async () => {
    const init = { headers: { cookie: `${SESSION_COOKIE}=alice-session` } };
    const session = await app.request("/api/session", init, env);
    const me = await (await app.request("/api/me", init, env)).json();
    expect(me).toMatchObject({ handle: "alice", via: "session" });
    expect(await session.json()).toEqual({ me });
  });
});
