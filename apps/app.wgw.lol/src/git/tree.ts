import { text } from "./bytes";
import {
  FILE_MODE,
  isTree,
  parseCommit,
  parseTree,
  serializeTree,
  type TreeEntry,
} from "./objects";
import type { ObjectStore } from "./store";

export function readTree(store: ObjectStore, sha: string): TreeEntry[] {
  const object = store.read(sha);
  if (object === undefined || object.type !== "tree") {
    throw new Error(`missing tree ${sha}`);
  }
  return parseTree(object.content);
}

export function commitTree(store: ObjectStore, sha: string): string {
  const object = store.read(sha);
  if (object === undefined || object.type !== "commit") {
    throw new Error(`missing commit ${sha}`);
  }
  return parseCommit(object.content).tree;
}

/** Finds the entry at `path` inside `tree`. The empty path is the tree itself. */
export function lookupPath(store: ObjectStore, tree: string, path: string): TreeEntry | undefined {
  const segments = path.split("/").filter((segment) => segment !== "");
  let entry: TreeEntry = { mode: "40000", name: "", sha: tree };
  for (const segment of segments) {
    if (!isTree(entry.mode)) {
      return undefined;
    }
    const next = readTree(store, entry.sha).find((child) => child.name === segment);
    if (next === undefined) {
      return undefined;
    }
    entry = next;
  }
  return entry;
}

export interface FileEntry {
  path: string;
  sha: string;
  size: number;
}

/** Every regular file under `tree`, with its blob hash and size. Symlinks and submodules are left out. */
export function listFiles(
  store: ObjectStore,
  tree: string,
  prefix = "",
  out: FileEntry[] = [],
): FileEntry[] {
  for (const entry of readTree(store, tree)) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (isTree(entry.mode)) {
      listFiles(store, entry.sha, path, out);
    } else if (entry.mode === "100644" || entry.mode === "100755") {
      out.push({ path, sha: entry.sha, size: store.raw(entry.sha)?.size ?? 0 });
    }
  }
  return out;
}

export function readBlobText(store: ObjectStore, tree: string, path: string): string | undefined {
  const entry = lookupPath(store, tree, path);
  if (entry === undefined || isTree(entry.mode)) {
    return undefined;
  }
  const blob = store.read(entry.sha);
  return blob === undefined ? undefined : text(blob.content);
}

/** A regular file, an executable, and a symlink, whose content is the link target. */
export const FILE_MODES = new Set(["100644", "100755", "120000"]);

export interface FileChange {
  path: string;
  /** New file content, or null to delete the path. */
  content: Uint8Array | null;
  /** One of FILE_MODES. Without it, an updated file keeps its mode and a new file is 100644. */
  mode?: string;
}

/** Applies file writes and deletes to `base` and returns the new root tree. */
export function applyChanges(
  store: ObjectStore,
  base: string | null,
  changes: FileChange[],
): string {
  const entries = new Map<string, TreeEntry>();
  if (base !== null) {
    for (const entry of readTree(store, base)) {
      entries.set(entry.name, entry);
    }
  }
  const nested = new Map<string, FileChange[]>();
  for (const change of changes) {
    const path = change.path.replace(/^\/+/, "");
    const slash = path.indexOf("/");
    if (slash === -1) {
      if (change.content === null) {
        entries.delete(path);
      } else {
        const sha = store.write("blob", change.content);
        const kept = entries.get(path)?.mode;
        const mode = change.mode ?? (kept !== undefined && FILE_MODES.has(kept) ? kept : FILE_MODE);
        entries.set(path, { mode, name: path, sha });
      }
      continue;
    }
    const head = path.slice(0, slash);
    const list = nested.get(head) ?? [];
    list.push({ ...change, path: path.slice(slash + 1) });
    nested.set(head, list);
  }
  for (const [name, list] of nested) {
    const current = entries.get(name);
    const subtree = applyChanges(
      store,
      current !== undefined && isTree(current.mode) ? current.sha : null,
      list,
    );
    if (readTree(store, subtree).length === 0) {
      entries.delete(name);
    } else {
      entries.set(name, { mode: "40000", name, sha: subtree });
    }
  }
  return store.write("tree", serializeTree([...entries.values()]));
}
