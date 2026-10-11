import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import { utf8 } from "../src/git/bytes";
import { rulesOf } from "../src/git/projection";
import type { GitRepo, View } from "../src/git/repo";
import { PrivateRules } from "../src/git/rules";
import { listFiles } from "../src/git/tree";
import type { Access } from "../src/server/auth";
import { findRepoById, type RepoRow } from "../src/server/db";
import type { Env } from "../src/server/env";
import {
  chunkLines,
  indexRepo,
  searchPublic,
  searchRepo,
  vectorId,
  visibilityOf,
} from "../src/server/search";
import { memoryRepo } from "./memory";

const person = { name: "Tester", email: "t@example.com", time: 1_760_000_000, tz: "+0000" };
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

/** D1 over node:sqlite, with the app's migrations applied. */
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS).toSorted()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf-8"));
  }
  const meta = {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
  };
  const statement = (sql: string, params: SQLInputValue[] = []): D1PreparedStatement => ({
    bind: (...next: unknown[]) => statement(sql, next as SQLInputValue[]),
    // The callers name the row type, as they do with D1.
    all: (async () => ({
      success: true as const,
      results: db.prepare(sql).all(...params),
      meta,
    })) as D1PreparedStatement["all"],
    first: async <T>() => (db.prepare(sql).get(...params) ?? null) as T | null,
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true as const, results: [], meta };
    },
    raw: () => {
      throw new Error("unexpected raw query");
    },
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async <T>(list: D1PreparedStatement[]) => {
      for (const item of list) {
        await item.run();
      }
      return [] as Array<D1Result<T>>;
    },
    exec: () => {
      throw new Error("unexpected exec");
    },
    withSession: () => {
      throw new Error("unexpected session");
    },
    dump: () => {
      throw new Error("unexpected dump");
    },
  };
}

/** Hashes each word into one of 768 dimensions, so chunks that share words score high. */
function embedWords(text: string): number[] {
  const vector = Array.from({ length: 768 }, () => 0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let hash = 0;
    for (const char of word) {
      hash = (hash * 31 + char.charCodeAt(0)) % 768;
    }
    vector[hash] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

function fakeAi() {
  const texts: string[] = [];
  return {
    texts,
    run: async (_model: string, input: { text: string[] }) => {
      expect(input.text.length).toBeLessThanOrEqual(100);
      texts.push(...input.text);
      return { data: input.text.map(embedWords) };
    },
  };
}

/** An in-memory Vectorize index that enforces the ID and metadata limits. */
function fakeVectorize() {
  const vectors = new Map<string, VectorizeVector>();
  return {
    vectors,
    upsert: async (list: VectorizeVector[]) => {
      expect(list.length).toBeLessThanOrEqual(1000);
      for (const vector of list) {
        expect(utf8(vector.id).length).toBeLessThanOrEqual(64);
        expect(utf8(JSON.stringify(vector.metadata)).length).toBeLessThanOrEqual(10_240);
        vectors.set(vector.id, vector);
      }
      return { mutationId: "upsert" };
    },
    deleteByIds: async (ids: string[]) => {
      for (const id of ids) {
        vectors.delete(id);
      }
      return { mutationId: "delete" };
    },
    query: async (values: number[], options: VectorizeQueryOptions) => {
      const filter = Object.entries(options.filter ?? {});
      const matches = [...vectors.values()]
        .filter((vector) => filter.every(([key, want]) => vector.metadata?.[key] === want))
        .map((vector) => ({
          id: vector.id,
          metadata: vector.metadata,
          score: [...vector.values].reduce((sum, value, i) => sum + value * values[i], 0),
        }))
        .toSorted((a, b) => b.score - a.score)
        .slice(0, options.topK);
      return { matches, count: matches.length };
    },
  };
}

const ok = <T>(value: T) => ({ ok: true as const, value });

/** The search reads of the Repo Durable Object, over an in-memory git repository. */
function fakeStub(repo: GitRepo) {
  const tree = (rev: string) => repo.readCommit(repo.resolve("full", rev)!).tree;
  return {
    resolve: async (view: View, rev: string) => ok(repo.resolve(view, rev) ?? null),
    searchFiles: async (rev: string) => ok(listFiles(repo.objects, tree(rev))),
    privacy: async (rev: string) => ok({ rules: rulesOf(repo.objects, tree(rev)).key }),
    searchBlobs: async (shas: string[]) =>
      ok(
        shas.map((sha) => {
          const object = repo.objects.read(sha);
          return object?.type === "blob" ? object.content : null;
        }),
      ),
  };
}

function commit(repo: GitRepo, files: Record<string, string | Uint8Array | null>): void {
  repo.commitFiles(
    "main",
    undefined,
    "change",
    person,
    Object.entries(files).map(([path, content]) => ({
      path,
      content: typeof content === "string" ? utf8(content) : content,
    })),
  );
}

let db: D1Database;
let ai: ReturnType<typeof fakeAi>;
let code: ReturnType<typeof fakeVectorize>;
let gits: Map<string, GitRepo>;
let env: Env;

async function addRepo(id: string, visibility: "public" | "private"): Promise<GitRepo> {
  await db
    .prepare(
      "INSERT INTO repos (id, owner_id, name, visibility, default_branch, created_at) VALUES (?, 'usr_alice', ?, ?, 'main', 0)",
    )
    .bind(id, id.replace(/^repo_/, ""), visibility)
    .run();
  const git = memoryRepo();
  gits.set(id, git);
  return git;
}

async function grant(id: string, role: Access["role"]): Promise<Access> {
  const repo = (await findRepoById(env, id)) as RepoRow;
  return { repo, role, view: role === null ? "public" : "full", principal: null };
}

function indexed(repoId: string) {
  return [...code.vectors.values()]
    .map((vector) => vector.metadata ?? {})
    .filter((metadata) => metadata.repo_id === repoId);
}

function indexedPaths(repoId: string): string[] {
  return indexed(repoId)
    .map((metadata) => (typeof metadata.path === "string" ? metadata.path : ""))
    .toSorted((a, b) => a.localeCompare(b));
}

beforeEach(async () => {
  db = fakeD1();
  ai = fakeAi();
  code = fakeVectorize();
  gits = new Map();
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the fakes implement only the bindings search.ts calls.
  env = {
    DB: db,
    AI: ai,
    CODE: code,
    EVENTS: { send: async () => undefined },
    REPO: { getByName: (id: string) => fakeStub(gits.get(id)!) },
  } as unknown as Env;
  await db
    .prepare(
      "INSERT INTO users (id, handle, name, kind, provider, subject, created_at) VALUES ('usr_alice', 'alice', 'Alice', 'human', 'google', 'alice', 0)",
    )
    .run();
});

describe("chunkLines", () => {
  it("cuts whole lines into pieces of about 1,500 characters and keeps line numbers", () => {
    const lines = Array.from(
      { length: 40 },
      (_, i) => `${String(i + 1).padStart(3, "0")} ${"x".repeat(96)}`,
    );
    const chunks = chunkLines(`${lines.join("\n")}\n`);
    // 101 characters per line with its newline: 14 lines fit in 1,500.
    expect(chunks.map((chunk) => [chunk.start, chunk.end])).toEqual([
      [1, 14],
      [15, 28],
      [29, 40],
    ]);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1500);
      expect(chunk.text).toBe(lines.slice(chunk.start - 1, chunk.end).join("\n"));
    }
  });

  it("cuts a line longer than a chunk and leaves out blank lines", () => {
    // Line 1 is long, lines 2 to 2001 are blank, line 2002 is "last".
    const chunks = chunkLines(`${"y".repeat(4000)}\n${"\n".repeat(2000)}last\n`);
    expect(chunks).toEqual([
      { text: "y".repeat(1500), start: 1, end: 1 },
      { text: "last", start: 2002, end: 2002 },
    ]);
  });
});

describe("vectorId", () => {
  it("is deterministic and fits the 64-byte limit", async () => {
    const id = await vectorId("repo_x", "src/a.ts", "a".repeat(40), 0);
    expect(await vectorId("repo_x", "src/a.ts", "a".repeat(40), 0)).toBe(id);
    expect(utf8(id).length).toBeLessThanOrEqual(64);
    expect(await vectorId("repo_x", "src/a.ts", "a".repeat(40), 1)).not.toBe(id);
    expect(await vectorId("repo_x", "src/a.ts", "b".repeat(40), 0)).not.toBe(id);
    expect(await vectorId("repo_x", "é".repeat(5000), "a".repeat(40), 0)).toHaveLength(id.length);
  });
});

describe("visibility", () => {
  it("follows .gitprivate in a public repository", async () => {
    const rules = new PrivateRules("secret/\n*.pem\n");
    expect(visibilityOf({ visibility: "public" }, rules, "src/app.ts")).toBe("public");
    expect(visibilityOf({ visibility: "public" }, rules, "secret/plan.md")).toBe("private");
    expect(visibilityOf({ visibility: "public" }, rules, "keys/server.pem")).toBe("private");
    expect(visibilityOf({ visibility: "private" }, rules, "src/app.ts")).toBe("private");

    const git = await addRepo("repo_pub", "public");
    commit(git, {
      ".gitprivate": "secret/\n",
      "src/app.ts": "export function start() { return 'server'; }\n",
      "secret/plan.md": "launch plan\n",
    });
    await indexRepo(env, "repo_pub");
    const byPath = Object.fromEntries(indexed("repo_pub").map((meta) => [meta.path, meta]));
    expect(byPath["src/app.ts"]).toMatchObject({
      visibility: "public",
      start_line: 1,
      end_line: 1,
    });
    expect(byPath["secret/plan.md"]).toMatchObject({ visibility: "private" });
    expect(byPath[".gitprivate"]).toMatchObject({ visibility: "public" });
  });

  it("marks every chunk of a private repository private", async () => {
    const git = await addRepo("repo_priv", "private");
    commit(git, { "src/app.ts": "export const port = 8080;\n", "README.md": "# private\n" });
    await indexRepo(env, "repo_priv");
    const chunks = indexed("repo_priv");
    expect(chunks).toHaveLength(2);
    expect(chunks.every((meta) => meta.visibility === "private")).toBe(true);
  });
});

describe("indexRepo", () => {
  it("embeds only changed files and deletes the vectors of removed ones", async () => {
    const git = await addRepo("repo_pub", "public");
    commit(git, {
      "a.ts": "export const alpha = 'first version';\n",
      "b.ts": "export const beta = 'removed later';\n",
      "c.ts": "export const gamma = 'never changes';\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "dist/app.min.js": "var a=1;\n",
      "logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
      "big.txt": "z\n".repeat(200_000),
    });
    const first = await indexRepo(env, "repo_pub");
    expect(first).toEqual({ embedded: 3, removed: 0, more: false });
    expect(indexedPaths("repo_pub")).toEqual(["a.ts", "b.ts", "c.ts"]);
    // The binary file is recorded with no chunks, so it is not read again.
    const rows = await db
      .prepare("SELECT path, chunks FROM search_files WHERE repo_id = ? ORDER BY path")
      .bind("repo_pub")
      .all<{ path: string; chunks: number }>();
    expect(rows.results).toEqual([
      { path: "a.ts", chunks: 1 },
      { path: "b.ts", chunks: 1 },
      { path: "c.ts", chunks: 1 },
      { path: "logo.png", chunks: 0 },
    ]);

    commit(git, { "a.ts": "export const alpha = 'second version';\n", "b.ts": null });
    ai.texts.length = 0;
    const second = await indexRepo(env, "repo_pub");
    expect(second).toEqual({ embedded: 1, removed: 1, more: false });
    expect(ai.texts).toEqual(["a.ts\nexport const alpha = 'second version';"]);
    expect(indexedPaths("repo_pub")).toEqual(["a.ts", "c.ts"]);
    expect(indexed("repo_pub").find((meta) => meta.path === "a.ts")?.text).toContain(
      "second version",
    );

    ai.texts.length = 0;
    expect(await indexRepo(env, "repo_pub")).toEqual({ embedded: 0, removed: 0, more: false });
    expect(ai.texts).toEqual([]);
  });
});

describe("search", () => {
  beforeEach(async () => {
    const pub = await addRepo("repo_pub", "public");
    commit(pub, {
      ".gitprivate": "secret/\n",
      "src/token.ts": "check the bearer token before the request\n",
      "secret/token.ts": "the bearer token signing secret\n",
    });
    const priv = await addRepo("repo_priv", "private");
    commit(priv, { "src/token.ts": "private bearer token store\n" });
    await indexRepo(env, "repo_pub");
    await indexRepo(env, "repo_priv");
  });

  it("shows non-members only the public chunks of a repository", async () => {
    const outsider = await searchRepo(env, await grant("repo_pub", null), "bearer token", 10);
    expect(outsider.map((hit) => hit.path).toSorted()).toEqual([".gitprivate", "src/token.ts"]);
    expect(outsider[0]).toMatchObject({ path: "src/token.ts", start_line: 1, end_line: 1 });

    const member = await searchRepo(env, await grant("repo_pub", "read"), "bearer token", 10);
    expect(member.map((hit) => hit.path).toSorted()).toEqual([
      ".gitprivate",
      "secret/token.ts",
      "src/token.ts",
    ]);
  });

  it("searches public chunks of public repositories across repositories", async () => {
    const hits = await searchPublic(env, "bearer token", 10);
    expect(hits.map((hit) => `${hit.owner}/${hit.name}:${hit.path}`).toSorted()).toEqual([
      "alice/pub:.gitprivate",
      "alice/pub:src/token.ts",
    ]);
    expect(hits[0]).toMatchObject({ owner: "alice", name: "pub", path: "src/token.ts" });

    // A repository made private drops out before its reindex runs.
    await db.prepare("UPDATE repos SET visibility = 'private' WHERE id = 'repo_pub'").run();
    expect(await searchPublic(env, "bearer token", 10)).toEqual([]);
  });
});
