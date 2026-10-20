import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { beforeEach, describe, expect, it } from "vitest";

import { utf8 } from "../src/git/bytes";
import type { Person } from "../src/git/objects";
import type { GitRepo, View } from "../src/git/repo";
import type { FileChange } from "../src/git/tree";
import { app } from "../src/server/app";
import { mintToken } from "../src/server/auth";
import type { Env } from "../src/server/env";
import { guard } from "../src/server/result";
import { fakeD1, memoryRepo } from "./memory";

const ORIGIN = "https://app.wgw.lol";
const person = { name: "Tester", email: "t@example.com", time: 1_760_000_000, tz: "+0000" };
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} };

const READ_TOOLS = [
  "compare",
  "get_commit",
  "get_git_token",
  "get_pull",
  "get_repo",
  "list_commits",
  "list_pulls",
  "list_repos",
  "list_statuses",
  "list_tree",
  "read_file",
  "search_code",
  "whoami",
];
const WRITE_TOOLS = [
  "comment_pull",
  "commit_files",
  "create_branch",
  "create_repo",
  "merge_pull",
  "open_pull",
  "pull_env",
  "set_status",
];

/** The Repo Durable Object calls the tests reach, over an in-memory git repository. */
function fakeStub(repo: GitRepo) {
  return {
    refs: (view: View) => guard(() => ({ refs: repo.refs(view), head: repo.storage.refs.head() })),
    tree: (view: View, rev: string, path: string) => guard(() => repo.tree(view, rev, path)),
    blob: (view: View, rev: string, path: string) => guard(() => repo.blob(view, rev, path)),
    commitFiles: (
      branch: string,
      expected: string | undefined,
      message: string,
      who: Person,
      files: FileChange[],
      from?: string,
    ) => guard(() => repo.commitFiles(branch, expected, message, who, files, from)),
    resolve: (view: View, rev: string) => guard(() => repo.resolve(view, rev) ?? null),
    fullShas: (shas: string[]) => guard(() => shas.map((sha) => repo.fullShas(sha))),
  };
}

let env: Env;
let git: GitRepo;

async function connect(token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", ORIGIN), {
    requestInit: token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
    fetch: async (url, init) => app.fetch(new Request(url, init), env, ctx),
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((tool) => tool.name).toSorted();
}

/** The text of a tool result, and whether the tool failed. */
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const answer = await client.callTool({ name, arguments: args });
  const content = Array.isArray(answer.content) ? answer.content : [];
  return {
    failed: answer.isError === true,
    text: content.map((item) => (item.type === "text" ? item.text : "")).join("\n"),
  };
}

let aliceKey: string;
let bobKey: string;

beforeEach(async () => {
  const db = fakeD1();
  git = memoryRepo();
  git.commitFiles(
    "main",
    undefined,
    "change",
    person,
    Object.entries({
      ".gitprivate": "secret/\n",
      "src/app.ts": "export const port = 8080;\n",
      "secret/plan.md": "launch plan\n",
    }).map(([path, content]) => ({ path, content: utf8(content) })),
  );
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the fakes implement only the bindings the tools reach.
  env = {
    ORIGIN,
    COMMIT_SHA: "test",
    DB: db,
    REPO: { getByName: () => fakeStub(git) },
    METRICS: { writeDataPoint: () => undefined },
    EVENTS: { send: async () => undefined },
  } as unknown as Env;
  await db
    .prepare(
      "INSERT INTO users (id, handle, name, kind, provider, subject, created_at) VALUES ('usr_alice', 'alice', 'Alice', 'human', 'google', 'alice', 0), ('usr_bob', 'bob', 'Bob', 'human', 'google', 'bob', 0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO repos (id, owner_id, name, visibility, default_branch, created_at) VALUES ('repo_pub', 'usr_alice', 'pub', 'public', 'main', 0)",
    )
    .run();
  const keyOf = async (userId: string) =>
    (await mintToken(env, userId, { kind: "key", name: "test", scopes: ["write"] })).token;
  aliceKey = await keyOf("usr_alice");
  bobKey = await keyOf("usr_bob");
});

describe("mcp", () => {
  it("lists every tool for a key, and only the read tools without one", async () => {
    expect(await toolNames(await connect(aliceKey))).toEqual(
      [...READ_TOOLS, ...WRITE_TOOLS].toSorted(),
    );
    expect(await toolNames(await connect())).toEqual(READ_TOOLS);
  });

  it("answers a bad token with 401 and the protected resource metadata", async () => {
    const response = await app.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer wgw_wrong",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
    );
  });

  it("refuses write tools to an anonymous caller", async () => {
    const client = await connect();
    const created = await call(client, "create_repo", { name: "taken" });
    expect(created.failed).toBe(true);
    expect(created.text).toMatch(/create_repo not found/);
    const rows = await env.DB.prepare("SELECT name FROM repos").all<{ name: string }>();
    expect(rows.results.map((row) => row.name)).toEqual(["pub"]);
    // The whoami tool is listed, but /api/me has no account to show.
    expect(await call(client, "whoami", {})).toMatchObject({ failed: true, text: /^401 / });
  });

  it("refuses pull_env to a key without the secrets scope", async () => {
    const denied = await call(await connect(aliceKey), "pull_env", { owner: "alice", name: "pub" });
    expect(denied).toMatchObject({
      failed: true,
      text: /^403 .*the token lacks the secrets scope/,
    });

    const { token } = await mintToken(env, "usr_alice", {
      kind: "key",
      name: "secrets",
      scopes: ["write", "secrets"],
    });
    expect(await call(await connect(token), "pull_env", { owner: "alice", name: "pub" })).toEqual({
      failed: false,
      text: "{}",
    });
  });

  it("hides .gitprivate paths from a non-member in read_file and list_tree", async () => {
    const repo = { owner: "alice", name: "pub" };
    for (const client of [await connect(bobKey), await connect()]) {
      const root = await call(client, "list_tree", repo);
      expect(root.failed).toBe(false);
      const names = JSON.parse(root.text).items.map((item: { name: string }) => item.name);
      expect(names.toSorted()).toEqual([".gitprivate", "src"]);
      expect(await call(client, "list_tree", { ...repo, path: "secret" })).toMatchObject({
        failed: true,
        text: /^404 /,
      });
      expect(await call(client, "read_file", { ...repo, path: "secret/plan.md" })).toMatchObject({
        failed: true,
        text: /^404 /,
      });
    }

    const owner = await connect(aliceKey);
    const file = await call(owner, "read_file", { ...repo, path: "secret/plan.md" });
    expect(JSON.parse(file.text)).toMatchObject({ path: "secret/plan.md", text: "launch plan\n" });
  });

  it("commits an executable file through commit_files", async () => {
    const repo = { owner: "alice", name: "pub" };
    const client = await connect(aliceKey);
    const committed = await call(client, "commit_files", {
      ...repo,
      message: "add a script",
      files: [{ path: "bin/run.sh", content: "#!/bin/sh\necho hi\n", mode: "100755" }],
    });
    expect(committed.failed).toBe(false);
    expect(JSON.parse(committed.text)).toMatchObject({ branch: "main" });

    const listed = await call(client, "list_tree", { ...repo, path: "bin" });
    const items: Array<{ name: string; mode: string }> = JSON.parse(listed.text).items;
    expect(items.map(({ name, mode }) => ({ name, mode }))).toEqual([
      { name: "run.sh", mode: "100755" },
    ]);
  });

  it("posts a status with set_status and reads it back with list_statuses", async () => {
    const repo = { owner: "alice", name: "pub" };
    const sha = git.resolve("full", "main")!;
    const posted = await call(await connect(aliceKey), "set_status", {
      ...repo,
      sha,
      state: "failure",
      context: "tests",
      description: "2 failed",
      target_url: "https://ci.example/run/7",
    });
    expect(posted.failed).toBe(false);
    expect(JSON.parse(posted.text)).toMatchObject({ context: "tests", state: "failure" });

    const owner = await call(await connect(aliceKey), "list_statuses", { ...repo, sha });
    expect(JSON.parse(owner.text)).toMatchObject({
      sha,
      state: "failure",
      statuses: [{ context: "tests", description: "2 failed" }],
    });
    // A non-member reads the public commit; the full hash names a rewritten one.
    const projected = git.viewSha("public", sha)!;
    const outside = await call(await connect(), "list_statuses", { ...repo, sha: projected });
    expect(JSON.parse(outside.text)).toMatchObject({ sha: projected, state: "failure" });

    const denied = await call(await connect(bobKey), "set_status", {
      ...repo,
      sha,
      state: "success",
    });
    expect(denied).toMatchObject({ failed: true, text: /^403 / });
    const missing = await call(await connect(aliceKey), "set_status", {
      ...repo,
      sha: "a".repeat(40),
      state: "success",
    });
    expect(missing).toMatchObject({ failed: true, text: /^404 / });
  });
});
