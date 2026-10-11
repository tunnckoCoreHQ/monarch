import { type Bytes, concat } from "./bytes";
import { type FileDiff, diffTrees, fileDiff } from "./diff";
import { mergeTrees } from "./merge";
import {
  type Commit,
  type Person,
  isTree,
  parseCommit,
  parseTag,
  parseTree,
  serializeCommit,
  ZERO_SHA,
} from "./objects";
import { type PackSource, parsePack, type PackedObject, writePack } from "./pack";
import { FLUSH, pkt } from "./pktline";
import { type ProjectionMemo, NO_COMMIT, projectCommit } from "./projection";
import {
  advertiseRefs,
  parseReceiveRequest,
  parseUploadRequest,
  type Ref,
  type RefResult,
  reportStatus,
  type Service,
} from "./protocol";
import { RULES_FILE } from "./rules";
import type { ObjectStore } from "./store";
import { applyChanges, commitTree, type FileChange, lookupPath, readTree } from "./tree";
import { ancestors, isAncestor, mergeBase, planPack } from "./walk";
import { inflate } from "./zlib";

/** Members see the full repository. Everyone else sees the public projection. */
export type View = "full" | "public";

export interface RefStore {
  list(): Ref[];
  get(name: string): string | undefined;
  set(name: string, sha: string): void;
  delete(name: string): void;
  head(): string;
  setHead(name: string): void;
}

export interface ShallowStore {
  list(): string[];
  add(sha: string): void;
  delete(sha: string): void;
}

export interface Storage {
  objects: ObjectStore;
  refs: RefStore;
  memo: ProjectionMemo;
  /**
   * Commits a mirror fetched without their parents yet. A fetch that stops between rounds leaves
   * them here, and the next fetch resumes from them before it moves any ref.
   */
  shallow: ShallowStore;
  /** Loads the zlib stream of an object kept outside the store. */
  loadExternal(sha: string): Promise<Uint8Array>;
  /** Saves objects from a push or import; may move large blobs out of the store. */
  saveObjects(objects: PackedObject[]): Promise<void>;
  transaction<T>(run: () => T): T;
}

export interface RefUpdate {
  ref: string;
  old: string;
  new: string;
}

export interface CommitSummary {
  sha: string;
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
}

export interface TreeItem {
  name: string;
  path: string;
  type: "tree" | "blob" | "commit";
  mode: string;
  sha: string;
  size?: number;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "GitError";
  }
}

const VALID_REF =
  /^refs\/(heads|tags)\/(?!.*(?:\.\.|\/\/|@\{|\\|\.lock$|\/$|^\.|\/\.))[^\0- ~^:?*[]+$/;

export function isValidRef(name: string): boolean {
  return VALID_REF.test(name) && !name.endsWith(".") && !name.includes(" ");
}

function summarize(sha: string, commit: Commit): CommitSummary {
  return { sha, ...commit };
}

export class GitRepo {
  constructor(readonly storage: Storage) {}

  get objects(): ObjectStore {
    return this.storage.objects;
  }

  /** True when the commit carries no private paths, so the public projection keeps it as is. */
  isPublic(sha: string): boolean {
    const object = this.objects.read(sha);
    if (object?.type !== "commit") {
      return false;
    }
    return projectCommit(this.objects, this.storage.memo, sha) === sha;
  }

  /** The hash a commit or tag of the full repository has in the view, or undefined if none. */
  viewSha(view: View, sha: string): string | undefined {
    if (view === "full") {
      return sha;
    }
    const object = this.objects.read(sha);
    if (object?.type === "commit") {
      const projected = projectCommit(this.objects, this.storage.memo, sha);
      return projected === NO_COMMIT ? undefined : projected;
    }
    if (object?.type === "tag") {
      // An annotated tag stays public only when it points at an unchanged commit.
      const target = parseTag(object.content).object;
      return this.isPublic(target) ? sha : undefined;
    }
    return undefined;
  }

  refs(view: View): Ref[] {
    const refs: Ref[] = [];
    for (const ref of this.storage.refs.list()) {
      const sha = this.viewSha(view, ref.sha);
      if (sha !== undefined) {
        refs.push({ name: ref.name, sha });
      }
    }
    return refs.toSorted((a, b) => (a.name < b.name ? -1 : 1));
  }

  head(view: View): Ref | undefined {
    const name = this.storage.refs.head();
    return this.refs(view).find((ref) => ref.name === name);
  }

  defaultBranch(): string {
    return this.storage.refs.head().replace(/^refs\/heads\//, "");
  }

  /** Resolves a branch, tag, or commit hash to a commit visible in the view. */
  resolve(view: View, rev: string): string | undefined {
    const refs = this.refs(view);
    const named =
      refs.find((ref) => ref.name === rev) ??
      refs.find((ref) => ref.name === `refs/heads/${rev}`) ??
      refs.find((ref) => ref.name === `refs/tags/${rev}`);
    let sha = named?.sha;
    if (sha === undefined && /^[0-9a-f]{40}$/.test(rev) && this.objects.has(rev)) {
      sha = view === "full" || this.isPublic(rev) ? rev : undefined;
    }
    let object = sha === undefined ? undefined : this.objects.read(sha);
    while (object?.type === "tag") {
      sha = parseTag(object.content).object;
      object = this.objects.read(sha);
    }
    return object?.type === "commit" ? sha : undefined;
  }

  advertise(service: Service, view: View): Bytes {
    const refs = this.refs(view);
    return advertiseRefs(service, refs, this.head(view));
  }

  async uploadPack(body: Uint8Array, view: View): Promise<Bytes> {
    const request = parseUploadRequest(body);
    const tips = new Set(this.refs(view).map((ref) => ref.sha));
    for (const want of request.wants) {
      if (!tips.has(want) && !(view === "full" && this.objects.has(want))) {
        throw new GitError(`not our ref ${want}`);
      }
    }
    const parts: Uint8Array[] = [];
    const clientShallow = request.shallow.filter(
      (sha) => this.objects.has(sha) && (view === "full" || this.isPublic(sha)),
    );
    if (request.depth !== undefined) {
      const update = planPack(
        this.objects,
        request.wants,
        clientShallow,
        request.depth,
        clientShallow,
      );
      for (const sha of update.shallow) {
        parts.push(pkt(`shallow ${sha}\n`));
      }
      for (const sha of update.unshallow) {
        parts.push(pkt(`unshallow ${sha}\n`));
      }
      parts.push(FLUSH);
    }
    if (request.wantsOnly) {
      return concat(parts);
    }
    const common: string[] = [];
    for (const have of request.haves) {
      const visible = this.objects.has(have) && (view === "full" || this.isPublic(have));
      if (visible) {
        common.push(have);
        parts.push(pkt(`ACK ${have} common\n`));
      }
    }
    if (!request.done) {
      if (common.length > 0) {
        parts.push(pkt(`ACK ${common.at(-1)} ready\n`));
      }
      parts.push(pkt("NAK\n"));
      return concat(parts);
    }
    parts.push(pkt(common.length > 0 ? `ACK ${common.at(-1)}\n` : "NAK\n"));
    const plan = planPack(
      this.objects,
      request.wants,
      [...common, ...clientShallow],
      request.depth,
      clientShallow,
    );
    parts.push(await this.pack(plan.objects));
    return concat(parts);
  }

  async pack(shas: string[]): Promise<Bytes> {
    const sources: PackSource[] = [];
    for (const sha of shas) {
      const raw = this.objects.raw(sha);
      if (raw === undefined) {
        throw new GitError(`missing object ${sha}`, 500);
      }
      sources.push({
        type: raw.type,
        size: raw.size,
        zdata: raw.zdata ?? (await this.storage.loadExternal(sha)),
      });
    }
    return writePack(sources);
  }

  async receivePack(body: Uint8Array): Promise<{ response: Bytes; updates: RefUpdate[] }> {
    const request = parseReceiveRequest(body);
    let unpackError: string | undefined;
    const fresh = new Map<string, PackedObject>();
    if (request.pack.length > 0) {
      try {
        const objects = parsePack(request.pack, (sha) => this.objects.read(sha));
        await this.storage.saveObjects(objects);
        for (const object of objects) {
          fresh.set(object.sha, object);
        }
      } catch (error) {
        unpackError = error instanceof Error ? error.message : "invalid pack";
      }
    }
    const results: RefResult[] = [];
    const updates: RefUpdate[] = [];
    for (const command of request.commands) {
      const error =
        unpackError === undefined
          ? (this.checkUpdate(command) ?? this.checkConnected(command.new, fresh))
          : "unpacker error";
      results.push({ ref: command.ref, error });
      if (error === undefined) {
        updates.push({ ref: command.ref, old: command.old, new: command.new });
      }
    }
    const atomic = request.caps.includes("atomic");
    if (atomic && updates.length !== request.commands.length) {
      for (const result of results) {
        result.error ??= "atomic push failed";
      }
      return { response: reportStatus(unpackError, results), updates: [] };
    }
    this.applyUpdates(updates);
    return { response: reportStatus(unpackError, results), updates };
  }

  private checkUpdate(update: RefUpdate): string | undefined {
    if (!isValidRef(update.ref)) {
      return "invalid ref name";
    }
    const current = this.storage.refs.get(update.ref) ?? ZERO_SHA;
    if (current !== update.old) {
      return "fetch first";
    }
    if (update.new === ZERO_SHA) {
      return undefined;
    }
    const object = this.objects.read(update.new);
    if (object === undefined) {
      return "missing object";
    }
    if (update.ref.startsWith("refs/heads/") && object.type !== "commit") {
      return "not a commit";
    }
    return undefined;
  }

  /**
   * Checks that every object a pushed tip needs is present with the right type. Objects from this
   * pack are walked; objects that were already stored count as complete, like git's own check.
   */
  private checkConnected(tip: string, fresh: Map<string, PackedObject>): string | undefined {
    if (tip === ZERO_SHA) {
      return undefined;
    }
    const typeOf = (sha: string) => fresh.get(sha)?.type ?? this.objects.raw(sha)?.type;
    const stack: Array<{ sha: string; type: string }> = [{ sha: tip, type: typeOf(tip) ?? "" }];
    const seen = new Set<string>();
    try {
      while (stack.length > 0) {
        const { sha, type } = stack.pop()!;
        if (seen.has(sha)) {
          continue;
        }
        seen.add(sha);
        const actual = typeOf(sha);
        if (actual === undefined) {
          return `missing object ${sha}`;
        }
        if (actual !== type) {
          return `object ${sha} is a ${actual}, not a ${type}`;
        }
        const object = fresh.get(sha);
        if (object === undefined) {
          continue;
        }
        if (object.type === "commit") {
          const commit = parseCommit(object.content);
          const rules = this.rulesEntry(commit.tree, fresh);
          if (rules !== undefined && this.objects.raw(rules)?.zdata === undefined) {
            return `${RULES_FILE} is too large`;
          }
          stack.push(
            { sha: commit.tree, type: "tree" },
            ...commit.parents.map((parent) => ({ sha: parent, type: "commit" })),
          );
        } else if (object.type === "tree") {
          for (const entry of parseTree(object.content)) {
            if (entry.mode !== "160000") {
              stack.push({ sha: entry.sha, type: isTree(entry.mode) ? "tree" : "blob" });
            }
          }
        } else if (object.type === "tag") {
          const tag = parseTag(object.content);
          stack.push({ sha: tag.object, type: tag.type });
        }
      }
    } catch {
      return "malformed object";
    }
    return undefined;
  }

  private rulesEntry(tree: string, fresh: Map<string, PackedObject>): string | undefined {
    const content = fresh.get(tree)?.content ?? this.objects.read(tree)?.content;
    if (content === undefined) {
      return undefined;
    }
    return parseTree(content).find((entry) => entry.name === RULES_FILE && !isTree(entry.mode))
      ?.sha;
  }

  /** Applies ref updates in one transaction. The first branch pushed to an empty repo becomes HEAD. */
  applyUpdates(updates: RefUpdate[]): void {
    this.storage.transaction(() => {
      for (const update of updates) {
        if (update.new === ZERO_SHA) {
          this.storage.refs.delete(update.ref);
        } else {
          this.storage.refs.set(update.ref, update.new);
        }
      }
      const head = this.storage.refs.head();
      if (this.storage.refs.get(head) === undefined) {
        const branch = this.storage.refs.list().find((ref) => ref.name.startsWith("refs/heads/"));
        if (branch !== undefined) {
          this.storage.refs.setHead(branch.name);
        }
      }
    });
  }

  /** Compare-and-swap update of one ref, for merges and API commits. */
  updateRef(ref: string, expected: string, sha: string): RefUpdate {
    const error = this.checkUpdate({ ref, old: expected, new: sha });
    if (error !== undefined) {
      throw new GitError(`${ref}: ${error}`, 409);
    }
    const update = { ref, old: expected, new: sha };
    this.applyUpdates([update]);
    return update;
  }

  async importPack(pack: Uint8Array, refs: Ref[], head: string | undefined): Promise<RefUpdate[]> {
    const objects = parsePack(pack, (sha) => this.objects.read(sha));
    await this.storage.saveObjects(objects);
    const updates: RefUpdate[] = [];
    for (const ref of refs) {
      if (isValidRef(ref.name) && this.objects.has(ref.sha)) {
        updates.push({
          ref: ref.name,
          old: this.storage.refs.get(ref.name) ?? ZERO_SHA,
          new: ref.sha,
        });
      }
    }
    if (head !== undefined && updates.some((update) => update.ref === head)) {
      this.storage.refs.setHead(head);
    }
    this.applyUpdates(updates);
    return updates;
  }

  readCommit(sha: string): CommitSummary {
    const object = this.objects.read(sha);
    if (object?.type !== "commit") {
      throw new GitError(`unknown commit ${sha}`, 404);
    }
    return summarize(sha, parseCommit(object.content));
  }

  log(view: View, rev: string, limit = 30, path?: string): CommitSummary[] {
    const start = this.resolve(view, rev);
    if (start === undefined) {
      throw new GitError(`unknown revision ${rev}`, 404);
    }
    const cache = new Map<string, CommitSummary>();
    const read = (sha: string): CommitSummary => {
      let commit = cache.get(sha);
      if (commit === undefined) {
        commit = this.readCommit(sha);
        cache.set(sha, commit);
      }
      return commit;
    };
    const out: CommitSummary[] = [];
    const queue = [start];
    const seen = new Set<string>();
    while (queue.length > 0 && out.length < limit) {
      queue.sort((a, b) => read(b).committer.time - read(a).committer.time);
      const sha = queue.shift()!;
      if (seen.has(sha)) {
        continue;
      }
      seen.add(sha);
      const commit = read(sha);
      queue.push(...commit.parents.filter((parent) => this.objects.has(parent)));
      if (path !== undefined && path !== "") {
        const here = lookupPath(this.objects, commit.tree, path)?.sha;
        const parent = commit.parents[0];
        const before =
          parent === undefined || !this.objects.has(parent)
            ? undefined
            : lookupPath(this.objects, read(parent).tree, path)?.sha;
        if (here === before) {
          continue;
        }
      }
      out.push(commit);
    }
    return out;
  }

  tree(view: View, rev: string, path: string): { commit: string; items: TreeItem[] } {
    const commit = this.resolve(view, rev);
    if (commit === undefined) {
      throw new GitError(`unknown revision ${rev}`, 404);
    }
    const entry = lookupPath(this.objects, commitTree(this.objects, commit), path);
    if (entry === undefined || !isTree(entry.mode)) {
      throw new GitError(`no directory ${path}`, 404);
    }
    const prefix = path.replace(/^\/+|\/+$/g, "");
    const items = readTree(this.objects, entry.sha).map((child): TreeItem => {
      const type = isTree(child.mode) ? "tree" : child.mode === "160000" ? "commit" : "blob";
      return {
        name: child.name,
        path: prefix === "" ? child.name : `${prefix}/${child.name}`,
        type,
        mode: child.mode,
        sha: child.sha,
        size: type === "blob" ? this.objects.raw(child.sha)?.size : undefined,
      };
    });
    items.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "tree" ? -1 : 1,
    );
    return { commit, items };
  }

  async blob(
    view: View,
    rev: string,
    path: string,
  ): Promise<{ commit: string; sha: string; size: number; content: Uint8Array }> {
    const commit = this.resolve(view, rev);
    if (commit === undefined) {
      throw new GitError(`unknown revision ${rev}`, 404);
    }
    const entry = lookupPath(this.objects, commitTree(this.objects, commit), path);
    if (entry === undefined || isTree(entry.mode)) {
      throw new GitError(`no file ${path}`, 404);
    }
    const raw = this.objects.raw(entry.sha);
    if (raw === undefined) {
      throw new GitError(`missing blob ${entry.sha}`, 500);
    }
    if (raw.zdata === undefined) {
      return {
        commit,
        sha: entry.sha,
        size: raw.size,
        content: inflate(await this.storage.loadExternal(entry.sha)),
      };
    }
    return {
      commit,
      sha: entry.sha,
      size: raw.size,
      content: this.objects.read(entry.sha)!.content,
    };
  }

  diff(oldCommit: string | undefined, newCommit: string): FileDiff[] {
    const oldTree = oldCommit === undefined ? undefined : this.readCommit(oldCommit).tree;
    const changes = diffTrees(this.objects, oldTree, this.readCommit(newCommit).tree);
    return changes.map((change) => fileDiff(this.objects, change));
  }

  showCommit(view: View, rev: string): { commit: CommitSummary; files: FileDiff[] } {
    const sha = this.resolve(view, rev);
    if (sha === undefined) {
      throw new GitError(`unknown commit ${rev}`, 404);
    }
    const commit = this.readCommit(sha);
    return { commit, files: this.diff(commit.parents[0], sha) };
  }

  compare(
    view: View,
    base: string,
    head: string,
  ): {
    base: string;
    head: string;
    mergeBase?: string;
    commits: CommitSummary[];
    files: FileDiff[];
    mergeable: boolean;
    fastForward: boolean;
  } {
    const baseSha = this.resolve(view, base);
    const headSha = this.resolve(view, head);
    if (baseSha === undefined || headSha === undefined) {
      throw new GitError(`unknown revision ${baseSha === undefined ? base : head}`, 404);
    }
    const mergeBaseSha = mergeBase(this.objects, baseSha, headSha);
    const reachableFromBase = ancestors(this.objects, [baseSha]);
    const commits = [...ancestors(this.objects, [headSha])]
      .filter((sha) => !reachableFromBase.has(sha))
      .map((sha) => this.readCommit(sha))
      .toSorted((a, b) => a.committer.time - b.committer.time);
    const fastForward = isAncestor(this.objects, baseSha, headSha);
    let mergeable = fastForward;
    if (!mergeable && mergeBaseSha !== undefined) {
      mergeable =
        mergeTrees(
          this.objects,
          this.readCommit(mergeBaseSha).tree,
          this.readCommit(baseSha).tree,
          this.readCommit(headSha).tree,
        ).tree !== undefined;
    }
    return {
      base: baseSha,
      head: headSha,
      mergeBase: mergeBaseSha,
      commits,
      files: this.diff(mergeBaseSha, headSha),
      mergeable,
      fastForward,
    };
  }

  /**
   * Merges `head` into the branch `base`. A fast-forward moves the branch; otherwise a merge
   * commit with both parents records a path-level three-way merge.
   */
  merge(
    base: string,
    head: string,
    message: string,
    person: Person,
  ): { sha: string; head: string; update: RefUpdate } {
    const ref = `refs/heads/${base}`;
    const baseSha = this.storage.refs.get(ref);
    const headSha = this.resolve("full", head);
    if (baseSha === undefined || headSha === undefined) {
      throw new GitError("unknown branch", 404);
    }
    if (isAncestor(this.objects, headSha, baseSha)) {
      throw new GitError("nothing to merge", 409);
    }
    if (isAncestor(this.objects, baseSha, headSha)) {
      return { sha: headSha, head: headSha, update: this.updateRef(ref, baseSha, headSha) };
    }
    const mergeBaseSha = mergeBase(this.objects, baseSha, headSha);
    if (mergeBaseSha === undefined) {
      throw new GitError("no common history", 409);
    }
    const result = mergeTrees(
      this.objects,
      this.readCommit(mergeBaseSha).tree,
      this.readCommit(baseSha).tree,
      this.readCommit(headSha).tree,
    );
    if (result.tree === undefined) {
      throw new GitError(`merge conflict in ${result.conflicts.join(", ")}`, 409);
    }
    const sha = this.objects.write(
      "commit",
      serializeCommit({
        tree: result.tree,
        parents: [baseSha, headSha],
        author: person,
        committer: person,
        message,
      }),
    );
    return { sha, head: headSha, update: this.updateRef(ref, baseSha, sha) };
  }

  /**
   * Commits file changes on top of a branch, for agents and the API that work without a clone. A
   * new branch starts from `from` (a ref or commit hash), else from the default branch tip. Only
   * the first commit of an empty repository has no parent.
   */
  commitFiles(
    branch: string,
    expected: string | undefined,
    message: string,
    person: Person,
    files: FileChange[],
    from?: string,
  ): { sha: string; update: RefUpdate } {
    const ref = `refs/heads/${branch}`;
    const current = this.storage.refs.get(ref);
    if (expected !== undefined && expected !== (current ?? ZERO_SHA)) {
      throw new GitError(`${branch} moved to ${current ?? "nothing"}; fetch first`, 409);
    }
    if (current !== undefined && from !== undefined) {
      throw new GitError(`${branch} already exists; from only starts a new branch`, 409);
    }
    const parent =
      current ??
      (from === undefined
        ? this.storage.refs.get(this.storage.refs.head())
        : this.resolve("full", from));
    if (from !== undefined && parent === undefined) {
      throw new GitError(`unknown revision ${from}`, 404);
    }
    const parentTree = parent === undefined ? null : this.readCommit(parent).tree;
    const tree = applyChanges(this.objects, parentTree, files);
    const sha = this.objects.write(
      "commit",
      serializeCommit({
        tree,
        parents: parent === undefined ? [] : [parent],
        author: person,
        committer: person,
        message,
      }),
    );
    return { sha, update: this.updateRef(ref, current ?? ZERO_SHA, sha) };
  }

  /** Lists every object reachable from the given commits or tags. */
  reachable(wants: string[]): string[] {
    return planPack(this.objects, wants, []).objects;
  }

  readmeName(view: View, rev: string): string | undefined {
    try {
      return this.tree(view, rev, "").items.find(
        (item) => item.type === "blob" && /^readme(\.md|\.markdown|\.txt)?$/i.test(item.name),
      )?.name;
    } catch {
      return undefined;
    }
  }
}
