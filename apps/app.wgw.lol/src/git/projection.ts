import { text } from "./bytes";
import { isTree, parseCommit, rewriteCommit, serializeTree, type TreeEntry } from "./objects";
import { PrivateRules, RULES_FILE } from "./rules";
import { EMPTY_TREE, type ObjectStore } from "./store";
import { commitTree, readTree } from "./tree";

/** Memo tables for the public projection. The Durable Object persists them in SQLite. */
export interface ProjectionMemo {
  getCommit(sha: string): string | undefined;
  setCommit(sha: string, projected: string): void;
  /** The commits whose public counterpart is `projected`. */
  sources(projected: string): string[];
  getTree(key: string): string | undefined;
  setTree(key: string, projected: string): void;
}

/** The empty string marks a commit with no public counterpart. */
export const NO_COMMIT = "";

export function rulesOf(store: ObjectStore, tree: string): PrivateRules {
  const entry = readTree(store, tree).find(
    (item) => item.name === RULES_FILE && !isTree(item.mode),
  );
  if (entry === undefined) {
    return new PrivateRules("");
  }
  const blob = store.read(entry.sha);
  if (blob === undefined) {
    // Fail closed: rules that cannot be read must not publish the paths they hide.
    throw new Error(`cannot read ${RULES_FILE} ${entry.sha}`);
  }
  return new PrivateRules(text(blob.content));
}

export function filterTree(
  store: ObjectStore,
  memo: ProjectionMemo,
  rules: PrivateRules,
  tree: string,
  prefix: string,
): string {
  const key = `${tree}\0${prefix}\0${rules.key}`;
  const cached = memo.getTree(key);
  if (cached !== undefined) {
    return cached;
  }
  let changed = false;
  const kept: TreeEntry[] = [];
  for (const entry of readTree(store, tree)) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const dir = isTree(entry.mode);
    if (rules.matches(path, dir)) {
      changed = true;
      continue;
    }
    if (dir && rules.reachesInto(path)) {
      const sub = filterTree(store, memo, rules, entry.sha, path);
      if (sub !== entry.sha) {
        changed = true;
      }
      if (sub !== EMPTY_TREE) {
        kept.push({ ...entry, sha: sub });
      }
      continue;
    }
    kept.push(entry);
  }
  const result = changed ? store.write("tree", serializeTree(kept)) : tree;
  memo.setTree(key, result);
  return result;
}

/**
 * Maps a commit to its public counterpart. Each commit's own `.gitprivate` decides which paths it
 * hides, so later rule changes never rewrite earlier public commits. A rewritten commit whose
 * public tree equals its parent's is dropped, which keeps private-only commits out of the public
 * history. Commits without private paths keep their hashes.
 */
export function projectCommit(store: ObjectStore, memo: ProjectionMemo, start: string): string {
  const stack = [start];
  while (stack.length > 0) {
    const sha = stack.at(-1)!;
    if (memo.getCommit(sha) !== undefined) {
      stack.pop();
      continue;
    }
    const object = store.read(sha);
    if (object === undefined || object.type !== "commit") {
      throw new Error(`missing commit ${sha}`);
    }
    const commit = parseCommit(object.content);
    const missing = commit.parents.filter((parent) => memo.getCommit(parent) === undefined);
    if (missing.length > 0) {
      stack.push(...missing);
      continue;
    }
    stack.pop();
    const rules = rulesOf(store, commit.tree);
    const tree = rules.empty ? commit.tree : filterTree(store, memo, rules, commit.tree, "");
    const parents = [
      ...new Set(
        commit.parents
          .map((parent) => memo.getCommit(parent)!)
          .filter((parent) => parent !== NO_COMMIT),
      ),
    ];
    let projected: string;
    if (
      tree === commit.tree &&
      parents.length === commit.parents.length &&
      parents.every((parent, i) => parent === commit.parents[i])
    ) {
      projected = sha;
    } else if (parents.length === 1 && commitTree(store, parents[0]) === tree) {
      projected = parents[0];
    } else if (parents.length === 0 && tree === EMPTY_TREE) {
      projected = NO_COMMIT;
    } else {
      projected = store.write("commit", rewriteCommit(object.content, tree, parents));
    }
    memo.setCommit(sha, projected);
  }
  return memo.getCommit(start)!;
}
