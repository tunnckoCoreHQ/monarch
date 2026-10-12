import { createHmac } from "node:crypto";

import { exportPKCS8, generateKeyPair } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { utf8 } from "../src/git/bytes";
import { type Person, ZERO_SHA } from "../src/git/objects";
import type { GitRepo, View } from "../src/git/repo";
import type { FileChange } from "../src/git/tree";
import { returnPath } from "../src/lib/return-path";
import { app } from "../src/server/app";
import { mintToken } from "../src/server/auth";
import type { Scope } from "../src/server/db";
import type { Env } from "../src/server/env";
import { guard } from "../src/server/result";
import { sha256 } from "../src/server/util";
import { isWebhookMessage } from "../src/server/webhooks";
import { fakeD1, memoryRepo } from "./memory";

const ORIGIN = "https://app.wgw.lol";
const person = { name: "Tester", email: "t@example.com", time: 1_760_000_000, tz: "+0000" };
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} };

/** The Repo Durable Object calls the tests reach, over an in-memory git repository. */
function fakeStub(repo: GitRepo) {
  return {
    refs: (view: View) => guard(() => ({ refs: repo.refs(view), head: repo.storage.refs.head() })),
    compare: (view: View, base: string, head: string) =>
      guard(() => repo.compare(view, base, head)),
    merge: (base: string, head: string, message: string, who: Person) =>
      guard(() => repo.merge(base, head, message, who)),
    commitFiles: (
      branch: string,
      expected: string | undefined,
      message: string,
      who: Person,
      files: FileChange[],
      from?: string,
    ) => guard(() => repo.commitFiles(branch, expected, message, who, files, from)),
    publicShas: (shas: string[]) =>
      guard(() => shas.map((sha) => repo.viewSha("public", sha) ?? null)),
    log: (view: View, rev: string, limit: number) => guard(() => repo.log(view, rev, limit)),
    showCommit: (view: View, rev: string) => guard(() => repo.showCommit(view, rev)),
    fullShas: (shas: string[]) => guard(() => shas.map((sha) => repo.fullShas(sha))),
    resolve: (view: View, rev: string) => guard(() => repo.resolve(view, rev) ?? null),
  };
}

let env: Env;
let git: GitRepo;
let signingKey: string;
let saved: Map<string, string>;
let sent: unknown[];
// The master key that wraps each repository's key: 32 bytes, base64.
const KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

interface Call {
  token?: string;
  session?: string;
  json?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
}

async function call(method: string, path: string, options: Call = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  let body: string | undefined;
  if (options.token !== undefined) {
    headers.set("authorization", `Bearer ${options.token}`);
  }
  if (options.session !== undefined) {
    headers.set("cookie", `wgw_session=${options.session}`);
  }
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  }
  if (options.form !== undefined) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(options.form).toString();
  }
  return app.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }), env, ctx);
}

/** The JSON body; each test names the shape of the endpoint it calls. */
async function json<T>(response: Response | Promise<Response>): Promise<T> {
  return (await response).json<T>();
}

/** An API key; with no scopes given, a write key. */
async function key(
  userId: string,
  options: { scopes?: Scope[]; repoId?: string; environment?: string },
): Promise<string> {
  const minted = await mintToken(env, userId, {
    kind: "key",
    name: "test",
    scopes: options.scopes ?? ["write"],
    repoId: options.repoId,
    environment: options.environment,
  });
  return minted.token;
}

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  signingKey = await exportPKCS8(privateKey);
});

beforeEach(async () => {
  const db = fakeD1();
  git = memoryRepo();
  saved = new Map();
  sent = [];
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the fakes implement only the bindings the tests reach.
  env = {
    ORIGIN,
    TRIAD_ISSUER: "https://triad.example",
    DB: db,
    REPO: { getByName: () => fakeStub(git) },
    LIMITER: { limit: async () => ({ success: true }) },
    CACHE: {
      put: async (name: string, value: string) => {
        saved.set(name, value);
      },
    },
    METRICS: { writeDataPoint: () => undefined },
    EVENTS: {
      send: async (message: unknown) => {
        sent.push(message);
      },
    },
    SIGNING_KEY: { get: async () => signingKey },
    SECRETS_KEK: { get: async () => KEK },
  } as unknown as Env;
  await db
    .prepare(
      "INSERT INTO users (id, handle, name, email, kind, provider, subject, created_at) VALUES ('usr_alice', 'alice', 'Alice', 'alice@example.com', 'human', 'google', 'alice', 0), ('usr_bob', 'bob', 'Bob', 'bob@example.com', 'human', 'google', 'bob', 0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO repos (id, owner_id, name, visibility, default_branch, created_at) VALUES ('repo_pub', 'usr_alice', 'pub', 'public', 'main', 0), ('repo_priv', 'usr_alice', 'priv', 'private', 'main', 0), ('repo_bob', 'usr_bob', 'own', 'public', 'main', 0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, level, created_at, expires_at) VALUES (?, 'usr_alice', 'full', 0, 4000000000)",
    )
    .bind(await sha256("alice-session"))
    .run();
});

/** A public commit with a private path, so the public view rewrites it. */
function seed(): string {
  return git.commitFiles(
    "main",
    undefined,
    "start",
    person,
    Object.entries({
      ".gitprivate": "secret/\n",
      "src/app.ts": "export const port = 8080;\n",
      "secret/plan.md": "launch plan\n",
    }).map(([path, content]) => ({ path, content: utf8(content) })),
  ).sha;
}

describe("sign-in return address", () => {
  const attacks = [
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "https://evil.example/",
    "javascript:alert(1)",
    "\\\\evil.example",
    "https://app.wgw.lol//evil.example",
    "///evil.example",
    "/%2F%2Fevil.example",
    "/\\\\evil.example",
    "/%5Cevil.example",
  ];

  it("keeps only addresses on this origin", () => {
    for (const value of attacks) {
      expect(returnPath(value, ORIGIN), value).toBe("/");
    }
    expect(returnPath(undefined, ORIGIN)).toBe("/");
    expect(returnPath("/alice/pub?tab=code#readme", ORIGIN)).toBe("/alice/pub?tab=code#readme");
    expect(returnPath("https://app.wgw.lol/alice/pub", ORIGIN)).toBe("/alice/pub");
    expect(returnPath("/alice//pub", ORIGIN)).toBe("/alice//pub");
  });

  it("stores / for a sign-in that would leave the origin", async () => {
    const queries = [
      ...attacks.map((value) => encodeURIComponent(value)),
      "/%09/evil.example",
      "%2F%5Cevil.example",
    ];
    for (const query of queries) {
      saved.clear();
      const response = await call("GET", `/auth/login?return_to=${query}`);
      expect(response.status).toBe(302);
      const state = JSON.parse([...saved.values()][0]) as { returnTo: string };
      expect(state.returnTo, query).toBe("/");
    }
  });
});

describe("auth.md agents", () => {
  const CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim";
  const JWT_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

  /** Registers an anonymous agent and has alice claim it. */
  async function claimed() {
    const registered = await json<{ registration_id: string; claim_token: string }>(
      call("POST", "/agent/identity", { json: { type: "anonymous" } }),
    );
    const started = await json<{
      claim_attempt: { user_code: string; verification_uri: string };
    }>(
      call("POST", "/agent/identity/claim", {
        json: { claim_token: registered.claim_token, email: "@alice" },
      }),
    );
    const attempt = new URL(started.claim_attempt.verification_uri).searchParams.get("attempt");
    const confirmed = await call("POST", `/api/claims/${attempt}`, {
      session: "alice-session",
      json: { user_code: started.claim_attempt.user_code },
    });
    expect(confirmed.status).toBe(200);
    const tokens = await json<{ access_token: string; identity_assertion: string }>(
      call("POST", "/oauth2/token", {
        form: { grant_type: CLAIM_GRANT, claim_token: registered.claim_token },
      }),
    );
    expect(tokens.access_token).toMatch(/^wgw_at_/);
    return { ...registered, ...tokens };
  }

  async function refused(agent: Awaited<ReturnType<typeof claimed>>) {
    const claim = await call("POST", "/oauth2/token", {
      form: { grant_type: CLAIM_GRANT, claim_token: agent.claim_token },
    });
    expect(claim.status).toBe(400);
    expect((await json<{ error: string }>(claim)).error).toBe("invalid_grant");
    const assertion = await call("POST", "/oauth2/token", {
      form: { grant_type: JWT_GRANT, assertion: agent.identity_assertion },
    });
    expect(assertion.status).toBe(400);
    expect((await json<{ error: string }>(assertion)).error).toBe("invalid_grant");
    const again = await call("POST", "/agent/identity/claim", {
      json: { claim_token: agent.claim_token, email: "@alice" },
    });
    expect((await json<{ error: string }>(again)).error).toBe("invalid_claim_token");
    expect((await call("GET", "/api/me", { token: agent.access_token })).status).toBe(401);
  }

  it("revokes the registration when the person revokes the agent's token", async () => {
    const agent = await claimed();
    const agents = await json<Array<{ id: string }>>(
      call("GET", "/api/agents", { session: "alice-session" }),
    );
    expect(agents.map((item) => item.id)).toEqual([agent.registration_id]);
    const keys = await json<Array<{ id: string; kind: string }>>(
      call("GET", "/api/keys", { session: "alice-session" }),
    );
    const token = keys.find((item) => item.kind === "agent")!;
    const revoke = () => call("DELETE", `/api/keys/${token.id}`, { session: "alice-session" });
    expect((await revoke()).status).toBe(200);
    expect((await revoke()).status).toBe(404);
    await refused(agent);
    expect(await json(call("GET", "/api/agents", { session: "alice-session" }))).toEqual([]);
  });

  it("revokes a claimed agent from the agents list", async () => {
    const agent = await claimed();
    expect((await call("GET", "/api/me", { token: agent.access_token })).status).toBe(200);
    const path = `/api/agents/${agent.registration_id}`;
    expect((await call("DELETE", path, { session: "alice-session" })).status).toBe(200);
    await refused(agent);
    expect((await call("DELETE", path, { session: "alice-session" })).status).toBe(404);
  });

  it("gives a grant that races a revoke no live token", async () => {
    const agent = await claimed();
    const path = `/api/agents/${agent.registration_id}`;
    expect((await call("DELETE", path, { session: "alice-session" })).status).toBe(200);
    // The grant read the registration before the revoke and mints after it.
    const late = await mintToken(env, "usr_alice", {
      kind: "agent",
      name: "late",
      scopes: ["write"],
      ttl: 3600,
      registrationId: agent.registration_id,
    });
    expect(late).toBeNull();
    // A token the old insert stored after the revoke is refused too.
    await env.DB.prepare(
      "INSERT INTO tokens (id, user_id, kind, name, prefix, token_hash, scopes, registration_id, created_at) VALUES ('tok_late', 'usr_alice', 'agent', 'late', 'wgw_at_late', ?, 'read write', ?, 0)",
    )
      .bind(await sha256("wgw_at_late"), agent.registration_id)
      .run();
    expect((await call("GET", "/api/me", { token: "wgw_at_late" })).status).toBe(401);
  });

  it("finishes a key revoke that stopped before the registration", async () => {
    const agent = await claimed();
    const keys = await json<Array<{ id: string; kind: string }>>(
      call("GET", "/api/keys", { session: "alice-session" }),
    );
    const token = keys.find((item) => item.kind === "agent")!;
    // The token is revoked and the registration is not, as after a failed second call.
    await env.DB.prepare("UPDATE tokens SET revoked_at = 1 WHERE id = ?").bind(token.id).run();
    const revoke = () => call("DELETE", `/api/keys/${token.id}`, { session: "alice-session" });
    expect((await revoke()).status).toBe(200);
    expect((await revoke()).status).toBe(404);
    await refused(agent);
    expect(await json(call("GET", "/api/agents", { session: "alice-session" }))).toEqual([]);
  });
});

describe("API keys", () => {
  it("returns the fields of the key list on create, plus the token", async () => {
    const created = await json<Record<string, unknown>>(
      call("POST", "/api/keys", {
        session: "alice-session",
        json: {
          name: "ci",
          scopes: ["write"],
          repo: "Alice/priv",
          environment: "staging",
          expires_in_days: 7,
        },
      }),
    );
    const listed = await json<Array<Record<string, unknown>>>(
      call("GET", "/api/keys", { session: "alice-session" }),
    );
    const { token, ...fields } = created;
    expect(listed).toEqual([fields]);
    expect(fields).toMatchObject({
      name: "ci",
      kind: "key",
      scopes: ["read", "write"],
      repo_id: "repo_priv",
      repo: "alice/priv",
      environment: "staging",
      last_used_at: null,
    });
    expect(fields.expires_at).toBe(Number(fields.created_at) + 7 * 24 * 3600);
    expect(String(token).startsWith(String(fields.prefix))).toBe(true);
  });
});

describe("repository activity", () => {
  it("shows non-members only public events, with public hashes", async () => {
    const start = seed();
    const hidden = git.commitFiles("main", undefined, "private only", person, [
      { path: "secret/plan.md", content: utf8("new plan\n") },
    ]).sha;
    const projected = git.viewSha("public", start)!;
    expect(projected).not.toBe(start);
    expect(git.viewSha("public", hidden)).toBe(projected);
    const events: Array<[string, unknown]> = [
      ["secrets_read", { environment: "production", names: ["DATABASE_URL"] }],
      ["push", { updates: [{ ref: "refs/heads/main", old: ZERO_SHA, new: start }] }],
      ["push", { updates: [{ ref: "refs/heads/main", old: start, new: hidden }] }],
      ["pull_merged", { number: 1, sha: hidden }],
    ];
    for (const [i, [type, data]] of events.entries()) {
      await env.DB.prepare(
        "INSERT INTO events (id, repo_id, actor_id, type, data, created_at) VALUES (?, 'repo_pub', 'usr_alice', ?, ?, ?)",
      )
        .bind(`evt_${i}`, type, JSON.stringify(data), i)
        .run();
    }
    const outside = await json<Array<{ type: string; data: unknown }>>(
      call("GET", "/api/repos/alice/pub/events"),
    );
    expect(outside.map(({ type, data }) => ({ type, data }))).toEqual([
      { type: "pull_merged", data: { number: 1, sha: projected } },
      {
        type: "push",
        data: { updates: [{ ref: "refs/heads/main", old: ZERO_SHA, new: projected }] },
      },
    ]);
    const inside = await json<Array<{ type: string }>>(
      call("GET", "/api/repos/alice/pub/events", { session: "alice-session" }),
    );
    expect(inside.map((event) => event.type)).toEqual([
      "pull_merged",
      "push",
      "push",
      "secrets_read",
    ]);
  });
});

describe("environment-limited keys", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      "INSERT INTO environments (repo_id, name, kind, created_at) VALUES ('repo_pub', 'staging', 'staging', 0), ('repo_pub', 'production', 'production', 0)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO variables (repo_id, environment, name, secret, value, updated_by, updated_at) VALUES ('repo_pub', '', 'LOG_LEVEL', 0, 'info', 'usr_alice', 0), ('repo_pub', 'staging', 'API_URL', 0, 'https://staging.example', 'usr_alice', 0)",
    ).run();
  });

  it("reads and writes only its own environment", async () => {
    const staging = await key("usr_alice", {
      scopes: ["write", "admin", "secrets"],
      environment: "staging",
    });
    const put = (name: string, environment?: string) =>
      call("PUT", `/api/repos/alice/pub/variables/${name}`, {
        token: staging,
        json: { value: "x", secret: false, environment },
      });
    expect((await put("API_URL", "staging")).status).toBe(200);
    expect((await put("LOG_LEVEL")).status).toBe(403);
    expect((await put("API_URL", "production")).status).toBe(403);
    const remove = await call("DELETE", "/api/repos/alice/pub/variables/LOG_LEVEL", {
      token: staging,
    });
    expect(remove.status).toBe(403);
    expect(
      await json(call("GET", "/api/repos/alice/pub/env?environment=staging", { token: staging })),
    ).toEqual({ LOG_LEVEL: "info", API_URL: "x" });
  });

  it("cannot change collaborators or environments", async () => {
    const staging = await key("usr_alice", { scopes: ["admin"], environment: "staging" });
    const attempts = [
      call("PUT", "/api/repos/alice/pub/collaborators/bob", {
        token: staging,
        json: { role: "admin" },
      }),
      call("DELETE", "/api/repos/alice/pub/collaborators/bob", { token: staging }),
      call("POST", "/api/repos/alice/pub/environments", {
        token: staging,
        json: { name: "staging", kind: "staging" },
      }),
      call("DELETE", "/api/repos/alice/pub/environments/staging", { token: staging }),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(403);
    }
    const role = await env.DB.prepare(
      "SELECT role FROM collaborators WHERE user_id = 'usr_bob'",
    ).first();
    expect(role).toBeNull();
    const unlimited = await key("usr_alice", { scopes: ["admin"] });
    const repositoryWide = await call("PUT", "/api/repos/alice/pub/variables/LOG_LEVEL", {
      token: unlimited,
      json: { value: "debug", secret: false },
    });
    expect(repositoryWide.status).toBe(200);
  });
});

/** Requests that make alice/<repo> private and delete it. */
function changeSettings(token: string, repo: string): Array<Promise<Response>> {
  return [
    call("PATCH", `/api/repos/alice/${repo}`, {
      token,
      json: { visibility: "private", description: "changed" },
    }),
    call("DELETE", `/api/repos/alice/${repo}`, { token }),
  ];
}

/** alice/pub is still there, public, with no description. */
async function pubUnchanged(): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT visibility, description FROM repos WHERE id = 'repo_pub'",
  ).first<{ visibility: string; description: string }>();
  expect(row).toEqual({ visibility: "public", description: "" });
}

describe("repository settings", () => {
  it("stay closed to a key limited to one environment", async () => {
    const staging = await key("usr_alice", { scopes: ["admin"], environment: "staging" });
    for (const response of await Promise.all(changeSettings(staging, "pub"))) {
      expect(response.status).toBe(403);
      expect((await json<{ message: string }>(response)).message).toBe(
        "the token is limited to the staging environment and cannot change repository settings",
      );
    }
    await pubUnchanged();
  });

  it("stay closed to a key limited to another repository", async () => {
    const other = await key("usr_alice", { scopes: ["admin"], repoId: "repo_priv" });
    for (const response of await Promise.all(changeSettings(other, "pub"))) {
      expect(response.status).toBe(403);
      expect((await json<{ message: string }>(response)).message).toBe(
        "the token is limited to another repository",
      );
    }
    await pubUnchanged();
    // A private repository outside the limit stays hidden.
    const pub = await key("usr_alice", { scopes: ["admin"], repoId: "repo_pub" });
    for (const response of await Promise.all(changeSettings(pub, "priv"))) {
      expect(response.status).toBe(404);
    }
    const own = await call("PATCH", "/api/repos/alice/priv", {
      token: other,
      json: { description: "mine" },
    });
    expect(own.status).toBe(200);
    expect((await json<{ description: string }>(own)).description).toBe("mine");
  });
});

describe("API commits", () => {
  it("keep file modes and accept a mode per file", async () => {
    seed();
    const alice = await key("usr_alice", {});
    const commit = (files: unknown[]) =>
      call("POST", "/api/repos/alice/pub/commits", {
        token: alice,
        json: { message: "change", files },
      });
    expect((await commit([{ path: "run.sh", content: "echo 1\n", mode: "100755" }])).status).toBe(
      201,
    );
    expect((await commit([{ path: "run.sh", content: "echo 2\n" }])).status).toBe(201);
    const script = git.tree("full", "main", "").items.find((item) => item.name === "run.sh");
    expect(script?.mode).toBe("100755");
    const wrong = await commit([{ path: "run.sh", content: "x", mode: "040000" }]);
    expect(wrong.status).toBe(400);
    expect((await json<{ message: string }>(wrong)).message).toMatch(/100644, 100755, or 120000/);
  });
});

describe("merged pull requests", () => {
  it("show non-members the public view's hashes and diff", async () => {
    const start = seed();
    git.updateRef("refs/heads/feature", ZERO_SHA, start);
    git.commitFiles("feature", undefined, "feature", person, [
      { path: "src/feature.ts", content: utf8("export const on = true;\n") },
      { path: "secret/notes.md", content: utf8("notes\n") },
    ]);
    git.commitFiles("main", undefined, "main moves", person, [
      { path: "README.md", content: utf8("# pub\n") },
    ]);
    const alice = await key("usr_alice", {});
    const opened = await call("POST", "/api/repos/alice/pub/pulls", {
      token: alice,
      json: { title: "Feature", head: "feature" },
    });
    expect(opened.status).toBe(201);
    expect(
      (await call("POST", "/api/repos/alice/pub/pulls/1/merge", { token: alice })).status,
    ).toBe(200);
    interface Pull {
      base_sha: string | null;
      head_sha: string | null;
      merge_sha: string | null;
    }
    const full = await json<Pull>(call("GET", "/api/repos/alice/pub/pulls/1", { token: alice }));
    const outside = await json<
      Pull & { compare: { error?: string; files?: Array<{ path: string }> } }
    >(call("GET", "/api/repos/alice/pub/pulls/1"));
    for (const field of ["base_sha", "head_sha", "merge_sha"] as const) {
      expect(outside[field]).toBe(git.viewSha("public", full[field]!));
      expect(outside[field]).not.toBe(full[field]);
    }
    expect(outside.compare.error).toBeUndefined();
    expect(outside.compare.files?.map((file) => file.path)).toEqual(["src/feature.ts"]);
    const listed = await json<Pull[]>(call("GET", "/api/repos/alice/pub/pulls?state=all"));
    expect(listed.map((pull) => pull.head_sha)).toEqual([outside.head_sha]);
  });

  it("keep their public files after the pull request adds a rule and its branch is gone", async () => {
    const start = git.commitFiles("main", undefined, "start", person, [
      { path: "src/app.ts", content: utf8("export const port = 8080;\n") },
    ]).sha;
    git.updateRef("refs/heads/feature", ZERO_SHA, start);
    const head = git.commitFiles("feature", undefined, "feature", person, [
      { path: ".gitprivate", content: utf8("secret/\n") },
      { path: "secret/plan.md", content: utf8("launch plan\n") },
      { path: "src/feature.ts", content: utf8("export const on = true;\n") },
    ]).sha;
    const alice = await key("usr_alice", {});
    await call("POST", "/api/repos/alice/pub/pulls", {
      token: alice,
      json: { title: "Feature", head: "feature" },
    });
    expect(
      (await call("POST", "/api/repos/alice/pub/pulls/1/merge", { token: alice })).status,
    ).toBe(200);
    git.updateRef("refs/heads/feature", head, ZERO_SHA);

    const outside = await json<{ compare: { error?: string; files?: Array<{ path: string }> } }>(
      call("GET", "/api/repos/alice/pub/pulls/1"),
    );
    expect(outside.compare.error).toBeUndefined();
    expect(outside.compare.files?.map((file) => file.path)).toEqual([
      ".gitprivate",
      "src/feature.ts",
    ]);
    const diff = await call("GET", "/api/repos/alice/pub/pulls/1/diff");
    expect(diff.status).toBe(200);
    const patch = await diff.text();
    expect(patch).toContain("src/feature.ts");
    expect(patch).not.toContain("secret/plan.md");
    const inside = await call("GET", "/api/repos/alice/pub/pulls/1/diff", { token: alice });
    expect(await inside.text()).toContain("secret/plan.md");
  });
});

describe("repository limits and inputs", () => {
  it("keeps a repository-limited key from commenting on another repository", async () => {
    await env.DB.prepare(
      "INSERT INTO pulls (id, repo_id, number, title, author_id, head, base, state, created_at, updated_at) VALUES ('pr_1', 'repo_pub', 1, 'Pull', 'usr_alice', 'feature', 'main', 'open', 0, 0)",
    ).run();
    const limited = await key("usr_bob", { repoId: "repo_bob" });
    const unlimited = await key("usr_bob", {});
    for (const [token, status] of [
      [limited, 403],
      [unlimited, 201],
    ] as const) {
      const response = await call("POST", "/api/repos/alice/pub/pulls/1/comments", {
        token,
        json: { body: "hi" },
      });
      expect(response.status).toBe(status);
    }
  });

  it("ignores the session cookie on git paths", async () => {
    const refs = await call("GET", "/alice/priv.git/info/refs?service=git-upload-pack", {
      session: "alice-session",
    });
    expect(refs.status).toBe(401);
    expect(refs.headers.get("www-authenticate")).toMatch(/^Basic/);
    const push = await call("POST", "/alice/pub.git/git-receive-pack", {
      session: "alice-session",
      headers: { origin: "https://evil.wgw.lol" },
    });
    expect(push.status).toBe(401);
  });

  it("refuses import URLs with credentials", async () => {
    const alice = await key("usr_alice", {});
    for (const url of ["https://me:secret@github.com/a/b", "https://ghp_token@github.com/a/b"]) {
      const response = await call("POST", "/api/repos", {
        token: alice,
        json: { name: "imported", import_url: url },
      });
      expect(response.status).toBe(400);
      expect((await json<{ message: string }>(response)).message).toMatch(/username or password/);
    }
    expect(await env.DB.prepare("SELECT 1 FROM repos WHERE name = 'imported'").first()).toBeNull();
  });

  it("rejects unknown visibility, role, and scope values", async () => {
    const alice = await key("usr_alice", { scopes: ["write", "admin"] });
    const created = await call("POST", "/api/repos", {
      token: alice,
      json: { name: "typo", visibility: "Private" },
    });
    expect(created.status).toBe(400);
    expect((await json<{ message: string }>(created)).message).toBe(
      "visibility must be public or private",
    );
    expect(await env.DB.prepare("SELECT 1 FROM repos WHERE name = 'typo'").first()).toBeNull();
    const updated = await call("PATCH", "/api/repos/alice/priv", {
      token: alice,
      json: { visibility: "Public" },
    });
    expect(updated.status).toBe(400);
    const role = await call("PUT", "/api/repos/alice/pub/collaborators/bob", {
      token: alice,
      json: { role: "owner" },
    });
    expect(role.status).toBe(400);
    const scope = await call("POST", "/api/repos/alice/pub/git-token", {
      token: alice,
      json: { scope: "admin" },
    });
    expect(scope.status).toBe(400);
    const repo = await env.DB.prepare("SELECT visibility FROM repos WHERE id = 'repo_priv'").first<{
      visibility: string;
    }>();
    expect(repo?.visibility).toBe("private");
  });
});

interface StatusJson {
  context: string;
  state: string;
  description: string;
  target_url: string | null;
  creator: string | null;
}
interface CombinedJson {
  sha: string;
  state: string | null;
  statuses: StatusJson[];
}

/** Posts a status on a commit of one of alice's repositories. */
const postStatus = (token: string, sha: string, body: unknown, repo = "pub") =>
  call("POST", `/api/repos/alice/${repo}/statuses/${sha}`, { token, json: body });
const listStatuses = (sha: string, token?: string) =>
  json<CombinedJson>(call("GET", `/api/repos/alice/pub/statuses/${sha}`, { token }));

describe("commit statuses", () => {
  it("replaces the status of a context when it is posted again", async () => {
    const sha = seed();
    const alice = await key("usr_alice", {});
    expect((await postStatus(alice, sha, { state: "pending", context: "tests" })).status).toBe(201);
    const replaced = await postStatus(alice, sha, {
      state: "success",
      context: "tests",
      description: "42 passed",
      target_url: "https://ci.example/run/1",
    });
    expect(replaced.status).toBe(201);
    expect(await json<StatusJson>(replaced)).toMatchObject({ context: "tests", state: "success" });
    expect((await postStatus(alice, sha, { state: "success" })).status).toBe(201);
    expect(await listStatuses(sha, alice)).toEqual({
      sha,
      state: "success",
      statuses: [
        expect.objectContaining({ context: "default", state: "success", target_url: null }),
        expect.objectContaining({
          context: "tests",
          state: "success",
          description: "42 passed",
          target_url: "https://ci.example/run/1",
          creator: "alice",
        }),
      ],
    });
  });

  it("combines the states: failure and error beat pending, which beats success", async () => {
    const sha = seed();
    const alice = await key("usr_alice", {});
    expect(await listStatuses(sha, alice)).toEqual({ sha, state: null, statuses: [] });
    const steps: Array<[string, string, string]> = [
      ["lint", "success", "success"],
      ["tests", "pending", "pending"],
      ["build", "error", "failure"],
      ["build", "success", "pending"],
      ["tests", "failure", "failure"],
      ["tests", "success", "success"],
    ];
    for (const [context, state, combined] of steps) {
      expect((await postStatus(alice, sha, { state, context })).status).toBe(201);
      expect((await listStatuses(sha, alice)).state, `${context} ${state}`).toBe(combined);
    }
  });

  it("validates the commit, state, context, description, and link", async () => {
    const sha = seed();
    const alice = await key("usr_alice", {});
    const bad: Array<[string, unknown, number, RegExp]> = [
      [sha.slice(0, 7), { state: "success" }, 400, /full 40-character/],
      ["f".repeat(40), { state: "success" }, 404, /has no commit/],
      [sha, {}, 400, /state must be/],
      [sha, { state: "passed" }, 400, /state must be/],
      [sha, { state: "success", context: "x".repeat(101) }, 400, /1 to 100/],
      [sha, { state: "success", context: " " }, 400, /1 to 100/],
      [sha, { state: "success", description: "x".repeat(141) }, 400, /140/],
      [sha, { state: "success", target_url: "http://ci.example/1" }, 400, /https/],
      [sha, { state: "success", target_url: "javascript:alert(1)" }, 400, /https/],
      [sha, { state: "success", target_url: "not a url" }, 400, /not a URL/],
    ];
    for (const [target, body, status, message] of bad) {
      const response = await postStatus(alice, target, body);
      expect(response.status, JSON.stringify(body)).toBe(status);
      expect((await json<{ message: string }>(response)).message).toMatch(message);
    }
    // A tree is an object the mirror knows, but not a commit.
    const tree = git.readCommit(sha).tree;
    expect((await postStatus(alice, tree, { state: "success" })).status).toBe(404);
    expect((await postStatus(alice, sha.toUpperCase(), { state: "success" })).status).toBe(201);
    expect((await call("POST", `/api/repos/alice/pub/statuses/${sha}`, { json: {} })).status).toBe(
      401,
    );
    const read = await key("usr_alice", { scopes: ["read"] });
    expect((await postStatus(read, sha, { state: "success" })).status).toBe(403);
    const bob = await key("usr_bob", {});
    expect((await postStatus(bob, sha, { state: "success" })).status).toBe(403);
    expect((await listStatuses(sha, alice)).statuses.map((status) => status.context)).toEqual([
      "default",
    ]);
  });

  it("shows non-members only the statuses of commits in the public view", async () => {
    const start = seed();
    const hidden = git.commitFiles("main", undefined, "private only", person, [
      { path: "secret/plan.md", content: utf8("new plan\n") },
    ]).sha;
    const alice = await key("usr_alice", {});
    expect((await postStatus(alice, start, { state: "success", context: "tests" })).status).toBe(
      201,
    );
    expect((await postStatus(alice, hidden, { state: "failure", context: "deploy" })).status).toBe(
      201,
    );
    // Publishing builds the public projection.
    git.refs("public");
    const projected = git.viewSha("public", start)!;
    expect(git.viewSha("public", hidden)).toBe(projected);

    const bob = await key("usr_bob", {});
    for (const token of [bob, undefined]) {
      const outside = await listStatuses(projected, token);
      expect(outside.state).toBe("success");
      expect(outside.statuses.map((status) => status.context)).toEqual(["tests"]);
      // The full hashes name a rewritten commit and a hidden one.
      expect((await listStatuses(start, token)).statuses).toEqual([]);
      expect((await listStatuses(hidden, token)).statuses).toEqual([]);
      const shown = await json<{ status: CombinedJson }>(
        call("GET", `/api/repos/alice/pub/commits/${projected}`, { token }),
      );
      expect(shown.status).toMatchObject({ sha: projected, state: "success" });
      const commits = await json<Array<{ sha: string; status: string | null }>>(
        call("GET", "/api/repos/alice/pub/commits", { token }),
      );
      expect(commits.map(({ sha, status }) => ({ sha, status }))).toEqual([
        { sha: projected, status: "success" },
      ]);
    }
    expect((await listStatuses(hidden, alice)).state).toBe("failure");
    expect((await listStatuses(projected, alice)).statuses).toEqual([]);
    const commits = await json<Array<{ sha: string; status: string | null }>>(
      call("GET", "/api/repos/alice/pub/commits", { token: alice }),
    );
    expect(commits.map(({ sha, status }) => ({ sha, status }))).toEqual([
      { sha: hidden, status: "failure" },
      { sha: start, status: "success" },
    ]);
    // A private repository stays hidden.
    const priv = await call("GET", `/api/repos/alice/priv/statuses/${start}`, { token: bob });
    expect(priv.status).toBe(404);
  });

  it("show on a pull request and in the pull request list", async () => {
    const start = seed();
    git.updateRef("refs/heads/feature", ZERO_SHA, start);
    const head = git.commitFiles("feature", undefined, "feature", person, [
      { path: "src/feature.ts", content: utf8("export const on = true;\n") },
    ]).sha;
    const alice = await key("usr_alice", {});
    expect(
      (
        await call("POST", "/api/repos/alice/pub/pulls", {
          token: alice,
          json: { title: "Feature", head: "feature" },
        })
      ).status,
    ).toBe(201);
    expect((await postStatus(alice, head, { state: "pending", context: "tests" })).status).toBe(
      201,
    );
    git.refs("public");
    interface Pull {
      status: CombinedJson | null;
    }
    const full = await json<Pull>(call("GET", "/api/repos/alice/pub/pulls/1", { token: alice }));
    expect(full.status).toMatchObject({ sha: head, state: "pending" });
    expect(full.status?.statuses.map((status) => status.context)).toEqual(["tests"]);
    const outside = await json<Pull>(call("GET", "/api/repos/alice/pub/pulls/1"));
    expect(outside.status).toMatchObject({ sha: git.viewSha("public", head), state: "pending" });
    const listed = await json<Array<{ status: string | null }>>(
      call("GET", "/api/repos/alice/pub/pulls"),
    );
    expect(listed.map((pull) => pull.status)).toEqual(["pending"]);
  });

  it("let a repository-limited key post only to its repository", async () => {
    const sha = seed();
    const limited = await key("usr_alice", { repoId: "repo_priv" });
    const other = await postStatus(limited, sha, { state: "success" });
    expect(other.status).toBe(403);
    expect((await postStatus(limited, sha, { state: "success" }, "priv")).status).toBe(201);
    const environment = await key("usr_alice", { environment: "production" });
    expect((await postStatus(environment, sha, { state: "success" })).status).toBe(201);
    const rows = await env.DB.prepare("SELECT repo_id FROM statuses ORDER BY repo_id").all<{
      repo_id: string;
    }>();
    expect(rows.results.map((row) => row.repo_id)).toEqual(["repo_priv", "repo_pub"]);
  });
});

/** The webhook messages queued so far, with their bodies parsed. */
function queued() {
  return sent
    .filter(isWebhookMessage)
    .map((message) => ({ ...message, payload: JSON.parse(message.body) }));
}

describe("webhooks", () => {
  it("shows the secret only on create and refuses unsafe URLs", async () => {
    const alice = await key("usr_alice", { scopes: ["admin"] });
    const created = await json<{ id: string; secret: string; events: string[] }>(
      call("POST", "/api/repos/alice/pub/hooks", {
        token: alice,
        json: { url: "https://hooks.example.com/wgw" },
      }),
    );
    expect(created.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(created.events).toEqual(["push"]);
    const listed = await json<Array<Record<string, unknown>>>(
      call("GET", "/api/repos/alice/pub/hooks", { token: alice }),
    );
    expect(listed.map((hook) => hook.id)).toEqual([created.id]);
    expect(listed[0]).not.toHaveProperty("secret");
    const stored = await env.DB.prepare("SELECT secret FROM webhooks").first<{ secret: string }>();
    expect(stored?.secret).toMatch(/^v2\./);
    for (const url of [
      "http://hooks.example.com/wgw",
      "https://localhost/hook",
      "https://app.wgw.lol/api/me",
      "https://10.0.0.8/hook",
      "https://192.168.1.1/hook",
      "https://169.254.169.254/latest",
      "https://[::1]/hook",
      "not a url",
    ]) {
      const response = await call("POST", "/api/repos/alice/pub/hooks", {
        token: alice,
        json: { url },
      });
      expect(response.status, url).toBe(400);
    }
    const unknown = await call("POST", "/api/repos/alice/pub/hooks", {
      token: alice,
      json: { url: "https://hooks.example.com/wgw", events: ["push", "issues"] },
    });
    expect(unknown.status).toBe(400);
  });

  it("queue signed payloads with the repository, sender, and delivery id", async () => {
    const start = seed();
    git.updateRef("refs/heads/feature", ZERO_SHA, start);
    git.commitFiles("feature", undefined, "feature", person, [
      { path: "src/feature.ts", content: utf8("export const on = true;\n") },
    ]);
    const alice = await key("usr_alice", { scopes: ["write", "admin"] });
    const hook = await json<{ secret: string }>(
      call("POST", "/api/repos/alice/pub/hooks", {
        token: alice,
        json: {
          url: "https://hooks.example.com/wgw",
          events: ["push", "pull_request", "pull_request_comment", "repository"],
        },
      }),
    );
    // Another hook takes pull requests only, and a paused one takes everything.
    await call("POST", "/api/repos/alice/pub/hooks", {
      token: alice,
      json: { url: "https://other.example.com/wgw", events: ["pull_request"] },
    });
    await call("POST", "/api/repos/alice/pub/hooks", {
      token: alice,
      json: { url: "https://paused.example.com/wgw", events: ["push"], active: false },
    });
    await call("POST", "/api/repos/alice/pub/pulls", {
      token: alice,
      json: { title: "Feature", head: "feature" },
    });
    await call("POST", "/api/repos/alice/pub/pulls/1/comments", {
      token: alice,
      json: { body: "looks good" },
    });
    const commit = await json<{ sha: string }>(
      call("POST", "/api/repos/alice/pub/commits", {
        token: alice,
        json: { message: "readme", files: [{ path: "README.md", content: "# pub\n" }] },
      }),
    );
    await call("PATCH", "/api/repos/alice/pub", { token: alice, json: { visibility: "private" } });

    const messages = queued();
    expect(messages.map((message) => [message.url, message.event])).toEqual([
      ["https://hooks.example.com/wgw", "pull_request"],
      ["https://other.example.com/wgw", "pull_request"],
      ["https://hooks.example.com/wgw", "pull_request_comment"],
      ["https://hooks.example.com/wgw", "push"],
      ["https://hooks.example.com/wgw", "repository"],
    ]);
    const [opened, , comment, push, repository] = messages;
    for (const message of messages.filter((item) => item.url === "https://hooks.example.com/wgw")) {
      expect(message.signature).toBe(
        `sha256=${createHmac("sha256", hook.secret).update(message.body).digest("hex")}`,
      );
      expect(message.payload.delivery).toBe(message.delivery);
      expect(message.payload.sender).toEqual({ handle: "alice" });
      expect(message.body).not.toContain(hook.secret);
    }
    expect(opened.payload).toMatchObject({
      action: "opened",
      pull_request: { number: 1, title: "Feature", head: "feature", base: "main", author: "alice" },
      repository: { owner: "alice", name: "pub", visibility: "public" },
    });
    expect(comment.payload).toMatchObject({
      action: "created",
      comment: { body: "looks good", author: "alice" },
      pull_request: { number: 1 },
    });
    expect(push.payload).toMatchObject({
      ref: "refs/heads/main",
      before: start,
      after: commit.sha,
      pusher: { handle: "alice" },
    });
    expect(repository.payload).toEqual({
      action: "visibility_changed",
      changes: { visibility: { from: "public" } },
      repository: { owner: "alice", name: "pub", visibility: "private" },
      sender: { handle: "alice" },
      delivery: repository.delivery,
    });
  });

  it("stay closed to keys limited to an environment or another repository", async () => {
    const alice = await key("usr_alice", { scopes: ["admin"] });
    const hook = await json<{ id: string }>(
      call("POST", "/api/repos/alice/pub/hooks", {
        token: alice,
        json: { url: "https://hooks.example.com/wgw" },
      }),
    );
    const staging = await key("usr_alice", { scopes: ["admin"], environment: "staging" });
    const other = await key("usr_alice", { scopes: ["admin"], repoId: "repo_priv" });
    const writer = await key("usr_alice", { scopes: ["write"] });
    const root = "/api/repos/alice/pub/hooks";
    for (const token of [staging, other, writer]) {
      const attempts = [
        call("GET", root, { token }),
        call("POST", root, { token, json: { url: "https://evil.example.com/wgw" } }),
        call("PATCH", `${root}/${hook.id}`, { token, json: { url: "https://evil.example.com" } }),
        call("DELETE", `${root}/${hook.id}`, { token }),
        call("GET", `${root}/${hook.id}/deliveries`, { token }),
        call("POST", `${root}/${hook.id}/ping`, { token }),
      ];
      for (const response of await Promise.all(attempts)) {
        expect(response.status).toBe(403);
      }
    }
    const rows = await env.DB.prepare("SELECT url FROM webhooks").all<{ url: string }>();
    expect(rows.results).toEqual([{ url: "https://hooks.example.com/wgw" }]);
    const own = await key("usr_alice", { scopes: ["admin"], repoId: "repo_pub" });
    expect((await call("GET", root, { token: own })).status).toBe(200);
  });
});
