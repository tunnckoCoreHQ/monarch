import { objectHash, type GitObject, type ObjectType } from "../src/git/objects";
import type { PackedObject } from "../src/git/pack";
import type { Ref } from "../src/git/protocol";
import { GitRepo, type Storage } from "../src/git/repo";
import type { RawObject } from "../src/git/store";
import { deflate, inflate } from "../src/git/zlib";

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
