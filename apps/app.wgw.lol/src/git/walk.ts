import { isTree, parseCommit, parseTag } from "./objects";
import type { ObjectStore } from "./store";
import { readTree } from "./tree";

export function parentsOf(store: ObjectStore, sha: string): string[] {
  const object = store.read(sha);
  return object?.type === "commit" ? parseCommit(object.content).parents : [];
}

/** All commits reachable from `starts`, including the starts. */
export function ancestors(store: ObjectStore, starts: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = starts.filter((sha) => store.has(sha));
  while (queue.length > 0) {
    const sha = queue.pop()!;
    if (seen.has(sha)) {
      continue;
    }
    seen.add(sha);
    queue.push(...parentsOf(store, sha));
  }
  return seen;
}

export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  return ancestors(store, [descendant]).has(ancestor);
}

/**
 * A best common ancestor of `a` and `b`: a commit reachable from both that no other common commit
 * descends from. When there are several, it picks the first in breadth-first order from `b`.
 */
export function mergeBase(store: ObjectStore, a: string, b: string): string | undefined {
  const fromA = ancestors(store, [a]);
  const common = [...ancestors(store, [b])].filter((sha) => fromA.has(sha));
  if (common.length === 0) {
    return undefined;
  }
  const older = ancestors(
    store,
    common.flatMap((sha) => parentsOf(store, sha)),
  );
  const best = new Set(common.filter((sha) => !older.has(sha)));
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (best.has(sha)) {
      return sha;
    }
    if (seen.has(sha)) {
      continue;
    }
    seen.add(sha);
    queue.push(...parentsOf(store, sha));
  }
  return undefined;
}

function addTree(store: ObjectStore, tree: string, into: Set<string>, skip: Set<string>): void {
  const stack = [tree];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (into.has(sha) || skip.has(sha)) {
      continue;
    }
    into.add(sha);
    for (const entry of readTree(store, sha)) {
      if (entry.mode === "160000") {
        continue;
      }
      if (isTree(entry.mode)) {
        stack.push(entry.sha);
      } else if (!skip.has(entry.sha)) {
        into.add(entry.sha);
      }
    }
  }
}

export interface PackPlan {
  objects: string[];
  /** Commits the client must record as new shallow boundaries. */
  shallow: string[];
  /** Commits the client marked shallow that this fetch deepens. */
  unshallow: string[];
}

/**
 * Lists the objects a fetch must send: everything reachable from `wants` that is not reachable
 * from `haves`. With `depth`, the walk stops after that many commits and reports the boundary.
 * `clientShallow` lists the client's shallow commits: the client has them but not their parents.
 */
export function planPack(
  store: ObjectStore,
  wants: string[],
  haves: string[],
  depth?: number,
  clientShallow: string[] = [],
): PackPlan {
  const bounded = new Set(clientShallow);
  const common = new Set<string>();
  const pending = haves.filter((sha) => store.has(sha));
  while (pending.length > 0) {
    const sha = pending.pop()!;
    if (common.has(sha)) {
      continue;
    }
    common.add(sha);
    if (!bounded.has(sha)) {
      pending.push(...parentsOf(store, sha));
    }
  }
  const commits: string[] = [];
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const seen = new Set<string>();
  const edges = new Set<string>();
  const roots: Array<{ sha: string; level: number }> = [];
  const objects = new Set<string>();
  for (const want of wants) {
    let sha = want;
    let object = store.read(sha);
    while (object?.type === "tag") {
      objects.add(sha);
      sha = parseTag(object.content).object;
      object = store.read(sha);
    }
    if (object?.type === "commit") {
      roots.push({ sha, level: 1 });
    } else if (object?.type === "tree") {
      addTree(store, sha, objects, new Set());
    } else if (store.has(sha)) {
      objects.add(sha);
    }
  }
  const queue = roots;
  while (queue.length > 0) {
    const { sha, level } = queue.shift()!;
    if (seen.has(sha)) {
      continue;
    }
    seen.add(sha);
    const parents = parentsOf(store, sha);
    const atBoundary = depth !== undefined && level >= depth;
    if (common.has(sha)) {
      // A deeper fetch walks on through commits the client has, down to its shallow commits.
      if (depth !== undefined && !atBoundary && parents.length > 0) {
        if (bounded.has(sha)) {
          unshallow.push(sha);
        }
        for (const parent of parents) {
          queue.push({ sha: parent, level: level + 1 });
        }
      }
      continue;
    }
    commits.push(sha);
    if (atBoundary) {
      if (parents.length > 0 && !bounded.has(sha)) {
        shallow.push(sha);
      }
      continue;
    }
    for (const parent of parents) {
      if (common.has(parent)) {
        edges.add(parent);
      }
      if (!common.has(parent) || depth !== undefined) {
        queue.push({ sha: parent, level: level + 1 });
      }
    }
  }
  const skip = new Set<string>();
  for (const sha of [...edges, ...unshallow, ...haves.filter((have) => common.has(have))]) {
    const object = store.read(sha);
    if (object?.type === "commit") {
      addTree(store, parseCommit(object.content).tree, skip, new Set());
    }
  }
  for (const sha of commits) {
    objects.add(sha);
    const object = store.read(sha)!;
    addTree(store, parseCommit(object.content).tree, objects, skip);
  }
  return { objects: [...objects], shallow, unshallow };
}
