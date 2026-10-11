import { concat, fromHex, sha1Hex, text, toHex, utf8 } from "./bytes";

export type ObjectType = "commit" | "tree" | "blob" | "tag";

export const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const TYPE_NAME: Record<number, ObjectType> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};
export const ZERO_SHA = "0".repeat(40);
export const TREE_MODE = "40000";
export const FILE_MODE = "100644";

export interface GitObject {
  type: ObjectType;
  content: Uint8Array;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface Person {
  name: string;
  email: string;
  time: number;
  tz: string;
}

export interface Commit {
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
}

export function objectHash(type: ObjectType, content: Uint8Array): string {
  return sha1Hex([utf8(`${type} ${content.length}\0`), content]);
}

export function isTree(mode: string): boolean {
  return mode === TREE_MODE;
}

export function parseTree(content: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < content.length) {
    const space = content.indexOf(0x20, pos);
    const nul = space === -1 ? -1 : content.indexOf(0, space);
    if (space === -1 || nul === -1 || nul + 21 > content.length) {
      throw new Error("malformed tree object");
    }
    const mode = text(content.subarray(pos, space));
    const name = text(content.subarray(space + 1, nul));
    const sha = toHex(content.subarray(nul + 1, nul + 21));
    entries.push({ mode: mode === "040000" ? TREE_MODE : mode, name, sha });
    pos = nul + 21;
  }
  return entries;
}

// Git sorts tree entries by the UTF-8 bytes of their names, comparing a tree's name as if it ended
// in "/". JavaScript compares UTF-16 code units, which order some non-ASCII names differently.
function sortKey(entry: TreeEntry): Uint8Array {
  return utf8(isTree(entry.mode) ? `${entry.name}/` : entry.name);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }
  return left.length - right.length;
}

export function serializeTree(entries: TreeEntry[]): Uint8Array {
  const sorted = entries
    .map((entry) => ({ entry, key: sortKey(entry) }))
    .toSorted((a, b) => compareBytes(a.key, b.key));
  const parts: Uint8Array[] = [];
  for (const { entry } of sorted) {
    parts.push(utf8(`${entry.mode} ${entry.name}\0`), fromHex(entry.sha));
  }
  return concat(parts);
}

function parsePerson(value: string): Person {
  const match = /^(.*?) <(.*)> (\d+) ([+-]\d{4})$/.exec(value);
  if (match === null) {
    return { name: value, email: "", time: 0, tz: "+0000" };
  }
  return { name: match[1], email: match[2], time: Number(match[3]), tz: match[4] };
}

export function formatPerson(person: Person): string {
  return `${person.name} <${person.email}> ${person.time} ${person.tz}`;
}

export function parseCommit(content: Uint8Array): Commit {
  const raw = text(content);
  const split = raw.indexOf("\n\n");
  const header = split === -1 ? raw : raw.slice(0, split);
  const message = split === -1 ? "" : raw.slice(split + 2);
  const commit: Commit = {
    tree: "",
    parents: [],
    author: parsePerson(""),
    committer: parsePerson(""),
    message,
  };
  for (const line of header.split("\n")) {
    if (line.startsWith("tree ")) {
      commit.tree = line.slice(5);
    } else if (line.startsWith("parent ")) {
      commit.parents.push(line.slice(7));
    } else if (line.startsWith("author ")) {
      commit.author = parsePerson(line.slice(7));
    } else if (line.startsWith("committer ")) {
      commit.committer = parsePerson(line.slice(10));
    }
  }
  return commit;
}

export function serializeCommit(commit: Commit): Uint8Array {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) {
    lines.push(`parent ${parent}`);
  }
  lines.push(
    `author ${formatPerson(commit.author)}`,
    `committer ${formatPerson(commit.committer)}`,
  );
  const message = commit.message.endsWith("\n") ? commit.message : `${commit.message}\n`;
  return utf8(`${lines.join("\n")}\n\n${message}`);
}

/**
 * Rewrites the tree and parent headers of a raw commit and drops its signature, which no longer
 * matches. The author, committer, encoding, and message bytes stay as they were.
 */
export function rewriteCommit(content: Uint8Array, tree: string, parents: string[]): Uint8Array {
  const raw = text(content);
  const split = raw.indexOf("\n\n");
  const header = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? "" : raw.slice(split);
  const kept: string[] = [`tree ${tree}`, ...parents.map((parent) => `parent ${parent}`)];
  let skippingContinuation = false;
  for (const line of header.split("\n")) {
    if (line.startsWith(" ")) {
      if (!skippingContinuation) {
        kept.push(line);
      }
      continue;
    }
    skippingContinuation = false;
    if (line.startsWith("tree ") || line.startsWith("parent ")) {
      continue;
    }
    if (line.startsWith("gpgsig") || line.startsWith("mergetag ")) {
      skippingContinuation = true;
      continue;
    }
    kept.push(line);
  }
  return utf8(`${kept.join("\n")}${body}`);
}

export interface Tag {
  object: string;
  type: ObjectType;
  tag: string;
}

export function parseTag(content: Uint8Array): Tag {
  const tag: Tag = { object: "", type: "commit", tag: "" };
  for (const line of text(content).split("\n")) {
    if (line === "") {
      break;
    }
    if (line.startsWith("object ")) {
      tag.object = line.slice(7);
    } else if (line.startsWith("type ")) {
      const type = line.slice(5);
      tag.type = isObjectType(type) ? type : "commit";
    } else if (line.startsWith("tag ")) {
      tag.tag = line.slice(4);
    }
  }
  return tag;
}

export function isObjectType(name: string): name is ObjectType {
  return name === "commit" || name === "tree" || name === "blob" || name === "tag";
}
