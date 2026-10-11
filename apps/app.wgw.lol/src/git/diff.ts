import { structuredPatch } from "diff";

import { text } from "./bytes";
import { isTree, type TreeEntry } from "./objects";
import type { ObjectStore } from "./store";
import { readTree } from "./tree";

export type ChangeStatus = "added" | "deleted" | "modified";

export interface Change {
  path: string;
  status: ChangeStatus;
  oldSha?: string;
  newSha?: string;
}

function entriesOf(store: ObjectStore, tree: string | undefined): Map<string, TreeEntry> {
  const map = new Map<string, TreeEntry>();
  if (tree !== undefined) {
    for (const entry of readTree(store, tree)) {
      map.set(entry.name, entry);
    }
  }
  return map;
}

/** Lists changed files between two trees. Either tree may be missing. */
export function diffTrees(
  store: ObjectStore,
  oldTree: string | undefined,
  newTree: string | undefined,
  prefix = "",
): Change[] {
  if (oldTree === newTree) {
    return [];
  }
  const before = entriesOf(store, oldTree);
  const after = entriesOf(store, newTree);
  const names = [...new Set([...before.keys(), ...after.keys()])].toSorted();
  const changes: Change[] = [];
  for (const name of names) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    const a = before.get(name);
    const b = after.get(name);
    if (a?.sha === b?.sha && a?.mode === b?.mode) {
      continue;
    }
    const aTree = a !== undefined && isTree(a.mode);
    const bTree = b !== undefined && isTree(b.mode);
    if (aTree || bTree) {
      changes.push(...diffTrees(store, aTree ? a.sha : undefined, bTree ? b.sha : undefined, path));
    }
    const aFile = a !== undefined && !aTree ? a : undefined;
    const bFile = b !== undefined && !bTree ? b : undefined;
    if (aFile !== undefined && bFile !== undefined) {
      changes.push({ path, status: "modified", oldSha: aFile.sha, newSha: bFile.sha });
    } else if (aFile !== undefined) {
      changes.push({ path, status: "deleted", oldSha: aFile.sha });
    } else if (bFile !== undefined) {
      changes.push({ path, status: "added", newSha: bFile.sha });
    }
  }
  return changes;
}

const MAX_DIFF_BYTES = 512 * 1024;

function blobText(store: ObjectStore, sha: string | undefined): string | null {
  if (sha === undefined) {
    return "";
  }
  const blob = store.read(sha);
  if (blob === undefined || blob.content.length > MAX_DIFF_BYTES) {
    return null;
  }
  if (blob.content.subarray(0, 8000).includes(0)) {
    return null;
  }
  return text(blob.content);
}

export interface FileDiff extends Change {
  binary: boolean;
  additions: number;
  deletions: number;
  patch: string;
}

export function fileDiff(store: ObjectStore, change: Change): FileDiff {
  const before = blobText(store, change.oldSha);
  const after = blobText(store, change.newSha);
  const a = change.status === "added" ? "/dev/null" : `a/${change.path}`;
  const b = change.status === "deleted" ? "/dev/null" : `b/${change.path}`;
  const header = [`diff --git a/${change.path} b/${change.path}`];
  if (change.status === "added") {
    header.push("new file mode 100644");
  } else if (change.status === "deleted") {
    header.push("deleted file mode 100644");
  }
  if (before === null || after === null) {
    return {
      ...change,
      binary: true,
      additions: 0,
      deletions: 0,
      patch: [...header, `Binary files ${a} and ${b} differ`, ""].join("\n"),
    };
  }
  const result = structuredPatch(a, b, before, after, "", "", { context: 3 });
  const lines = [...header, `--- ${a}`, `+++ ${b}`];
  let additions = 0;
  let deletions = 0;
  for (const hunk of result.hunks) {
    // Like git, an empty side names the line before the hunk, so a new file is -0,0.
    const oldStart = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart;
    const newStart = hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart;
    lines.push(`@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        additions++;
      } else if (line.startsWith("-")) {
        deletions++;
      }
      lines.push(line);
    }
  }
  return { ...change, binary: false, additions, deletions, patch: `${lines.join("\n")}\n` };
}
