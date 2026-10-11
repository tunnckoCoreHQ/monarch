import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { objectHash, type GitObject, type ObjectType } from "../src/git/objects";
import type { PackedObject } from "../src/git/pack";
import type { Ref } from "../src/git/protocol";
import { GitRepo, type Storage } from "../src/git/repo";
import type { RawObject } from "../src/git/store";
import { deflate, inflate } from "../src/git/zlib";

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

/** D1 over node:sqlite, with the app's migrations applied. */
export function fakeD1(): D1Database {
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
      const { changes } = db.prepare(sql).run(...params);
      return { success: true as const, results: [], meta: { ...meta, changes: Number(changes) } };
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

export function memoryRepo(): GitRepo {
  const objects = new Map<string, RawObject>();
  const refs = new Map<string, string>();
  const commits = new Map<string, string>();
  const trees = new Map<string, string>();
  const shallow = new Set<string>();
  let head = "refs/heads/main";
  const storage: Storage = {
    objects: {
      read(sha): GitObject | undefined {
        const raw = objects.get(sha);
        return raw?.zdata === undefined
          ? undefined
          : { type: raw.type, content: inflate(raw.zdata) };
      },
      raw: (sha) => objects.get(sha),
      has: (sha) => objects.has(sha),
      write(type: ObjectType, content: Uint8Array) {
        const sha = objectHash(type, content);
        if (!objects.has(sha)) {
          objects.set(sha, { type, size: content.length, zdata: deflate(content) });
        }
        return sha;
      },
    },
    refs: {
      list: (): Ref[] => [...refs].map(([name, sha]) => ({ name, sha })),
      get: (name) => refs.get(name),
      set: (name, sha) => {
        refs.set(name, sha);
      },
      delete: (name) => {
        refs.delete(name);
      },
      head: () => head,
      setHead: (name) => {
        head = name;
      },
    },
    memo: {
      getCommit: (sha) => commits.get(sha),
      setCommit: (sha, projected) => {
        commits.set(sha, projected);
      },
      getTree: (key) => trees.get(key),
      setTree: (key, projected) => {
        trees.set(key, projected);
      },
    },
    loadExternal: async () => {
      throw new Error("no external objects in memory");
    },
    saveObjects: async (packed: PackedObject[]) => {
      for (const object of packed) {
        objects.set(object.sha, {
          type: object.type,
          size: object.content.length,
          zdata: object.zdata,
        });
      }
    },
    shallow: {
      list: () => [...shallow],
      add: (sha) => {
        shallow.add(sha);
      },
      delete: (sha) => {
        shallow.delete(sha);
      },
    },
    transaction: (run) => run(),
  };
  return new GitRepo(storage);
}
