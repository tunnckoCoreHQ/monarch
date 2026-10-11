import { isTree, serializeTree, type TreeEntry } from "./objects";
import type { ObjectStore } from "./store";
import { readTree } from "./tree";

type Side = TreeEntry | undefined;

function same(a: Side, b: Side): boolean {
  return a?.sha === b?.sha && a?.mode === b?.mode;
}

function children(store: ObjectStore, entry: Side): Map<string, TreeEntry> {
  const map = new Map<string, TreeEntry>();
  if (entry !== undefined && isTree(entry.mode)) {
    for (const child of readTree(store, entry.sha)) {
      map.set(child.name, child);
    }
  }
  return map;
}

function mergeEntry(
  store: ObjectStore,
  base: Side,
  ours: Side,
  theirs: Side,
  path: string,
  conflicts: string[],
): Side {
  if (same(ours, theirs)) {
    return ours;
  }
  if (same(base, ours)) {
    return theirs;
  }
  if (same(base, theirs)) {
    return ours;
  }
  const treeOrNothing = (side: Side) => side === undefined || isTree(side.mode);
  if (
    ours !== undefined &&
    theirs !== undefined &&
    isTree(ours.mode) &&
    isTree(theirs.mode) &&
    treeOrNothing(base)
  ) {
    const b = children(store, base);
    const o = children(store, ours);
    const t = children(store, theirs);
    const merged: TreeEntry[] = [];
    for (const name of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
      const childPath = path === "" ? name : `${path}/${name}`;
      const child = mergeEntry(store, b.get(name), o.get(name), t.get(name), childPath, conflicts);
      if (child !== undefined) {
        merged.push({ ...child, name });
      }
    }
    // Each side deleted other files of this directory. Git keeps no empty directories.
    if (merged.length === 0 && path !== "") {
      return undefined;
    }
    return { mode: "40000", name: ours.name, sha: store.write("tree", serializeTree(merged)) };
  }
  conflicts.push(path === "" ? "/" : path);
  return ours;
}

function root(sha: string): TreeEntry {
  return { mode: "40000", name: "", sha };
}

export type MergeResult =
  | { tree: string; conflicts: [] }
  | { tree: undefined; conflicts: string[] };

/** A path-level three-way merge. Any path changed differently on both sides is a conflict. */
export function mergeTrees(
  store: ObjectStore,
  base: string,
  ours: string,
  theirs: string,
): MergeResult {
  const conflicts: string[] = [];
  const merged = mergeEntry(store, root(base), root(ours), root(theirs), "", conflicts);
  if (conflicts.length > 0 || merged === undefined) {
    return { tree: undefined, conflicts };
  }
  return { tree: merged.sha, conflicts: [] };
}
