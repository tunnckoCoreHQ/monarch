import { parseCommit, parseTag, ZERO_SHA } from "./objects";
import { PackLimitError, parsePack } from "./pack";
import type { Command } from "./protocol";
import { fetchPack, lsRemote, type Remote, sendPack } from "./remote";
import { GitError, type GitRepo, isValidRef, type RefUpdate, type Storage } from "./repo";
import { planPack } from "./walk";

/** Commits per fetch round. A round that is over a pack limit retries with a quarter of the depth. */
const FETCH_DEPTH = 256;

/** The two remotes behind one repository: members read and write `full`, anyone reads `public`. */
export interface Remotes {
  full: Remote;
  public: Remote;
}

/**
 * Keeps a local copy of the full remote and pushes its public projection to the public remote.
 * Reads run on the local copy; server-side writes apply locally first and then push.
 */
export class Mirror {
  private refreshing: Promise<RefUpdate[]> | undefined;
  private queued: Promise<RefUpdate[]> | undefined;
  private publishing: Promise<unknown> = Promise.resolve();
  /** Refs with a pushLocal in flight, and how many. Sync and publish leave them to that push. */
  private readonly pushing = new Map<string, number>();
  private readonly depth: number;

  constructor(
    readonly repo: GitRepo,
    readonly storage: Storage,
    readonly remotes: Remotes,
    private readonly fetcher?: typeof fetch,
    options: { fetchDepth?: number } = {},
  ) {
    this.depth = options.fetchDepth ?? FETCH_DEPTH;
  }

  /** Refreshes from the full remote, then publishes the public projection. */
  async sync(): Promise<RefUpdate[]> {
    const updates = await this.refresh();
    await this.publish();
    return updates;
  }

  /**
   * Fetches objects and refs from the full remote into storage and makes local refs equal the
   * remote refs (heads and tags only; deletes refs the remote no longer has; sets HEAD from the
   * advertisement's symref). It does not publish, so a broken public view never blocks a member's
   * write. A call during a run waits for one more run that starts after the current one, so it
   * always sees remote changes made before the call. Returns the local ref changes.
   */
  refresh(): Promise<RefUpdate[]> {
    if (this.refreshing === undefined) {
      this.refreshing = this.runRefresh().finally(() => {
        this.refreshing = undefined;
      });
      return this.refreshing;
    }
    // A run in progress may have read the remote refs before the change this caller wants to
    // see, so queue one more run after it. Callers that arrive meanwhile share that run.
    this.queued ??= this.refreshing
      .catch(() => undefined)
      .then(() => {
        this.queued = undefined;
        return this.refresh();
      });
    return this.queued;
  }

  /**
   * The recorded shallow commits that `tips` reach through stored objects. Only these hold back the
   * tips: a shallow commit left by an abandoned fetch, for a branch that is gone, stays recorded,
   * so it is never taken as complete, but it does not block anything.
   */
  private reachedBoundary(tips: string[]): Set<string> {
    const { objects, shallow } = this.storage;
    const recorded = new Set(shallow.list());
    const reached = new Set<string>();
    if (recorded.size === 0) {
      return reached;
    }
    const seen = new Set<string>();
    const stack = tips.filter((sha) => objects.has(sha));
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (seen.has(sha)) {
        continue;
      }
      seen.add(sha);
      if (recorded.has(sha)) {
        reached.add(sha);
        continue;
      }
      const object = objects.read(sha);
      if (object?.type === "commit") {
        stack.push(...parseCommit(object.content).parents.filter((parent) => objects.has(parent)));
      } else if (object?.type === "tag") {
        stack.push(parseTag(object.content).object);
      }
    }
    return reached;
  }

  /**
   * Fetches the objects for `wants` in rounds of at most FETCH_DEPTH commits, so a long history
   * never has to fit in one pack. Commits that arrive without their parents are recorded in
   * `storage.shallow` before their objects are saved, and sent back as `shallow` lines so the
   * remote skips the trees and blobs already here. Their missing parents are the next wants. A
   * fetch that stops between rounds leaves that record; `boundary` is the part of it the current
   * tips reach, which this fetch resumes.
   */
  private async fetchObjects(
    wants: string[],
    haves: string[],
    boundary: Set<string>,
  ): Promise<void> {
    const { objects, shallow } = this.storage;
    const missingParents = (): string[] => {
      const owed = new Set<string>();
      for (const sha of boundary) {
        const commit = objects.read(sha);
        const parents =
          commit === undefined
            ? []
            : parseCommit(commit.content).parents.filter((parent) => !objects.has(parent));
        if (parents.length === 0) {
          // Complete now, or recorded without its objects; either way no longer a boundary.
          boundary.delete(sha);
          shallow.delete(sha);
        }
        for (const parent of parents) {
          owed.add(parent);
        }
      }
      return [...owed];
    };
    const fetched: string[] = [];
    let pending = [...new Set([...wants, ...missingParents()])];
    let depth = this.depth;
    while (pending.length > 0) {
      let parsed;
      try {
        const pack = await fetchPack(
          this.remotes.full,
          pending,
          [...haves, ...boundary, ...fetched],
          this.fetcher,
          { depth, shallow: [...boundary] },
        );
        parsed = pack.length > 0 ? parsePack(pack, (sha) => objects.read(sha)) : [];
      } catch (error) {
        const tooLarge =
          error instanceof PackLimitError || (error instanceof GitError && error.status === 413);
        if (tooLarge && depth > 1) {
          depth = Math.max(1, Math.floor(depth / 4));
          continue;
        }
        if (tooLarge) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new GitError(
            `a single commit in the full remote is too large to mirror: ${reason}`,
            413,
          );
        }
        throw error;
      }
      const arrived = new Set(parsed.map((object) => object.sha));
      const extra: string[] = [];
      for (const object of parsed) {
        if (object.type === "tag") {
          const target = parseTag(object.content).object;
          if (!objects.has(target) && !arrived.has(target)) {
            extra.push(target);
          }
        } else if (object.type === "commit") {
          fetched.push(object.sha);
          const parents = parseCommit(object.content).parents;
          if (parents.some((parent) => !objects.has(parent) && !arrived.has(parent))) {
            boundary.add(object.sha);
            shallow.add(object.sha);
          }
        }
      }
      await this.storage.saveObjects(parsed);
      const unsent = pending.find((sha) => !objects.has(sha));
      if (unsent !== undefined) {
        throw new GitError(`the full remote did not send ${unsent}`, 502);
      }
      pending = [...new Set([...missingParents(), ...extra])];
      depth = this.depth;
    }
  }

  private async runRefresh(): Promise<RefUpdate[]> {
    const { objects, refs } = this.storage;
    // Refs a server-side write moves while this runs belong to that write; the refresh leaves them.
    const before = new Map(refs.list().map((ref) => [ref.name, ref.sha]));
    const remote = await lsRemote(this.remotes.full, "git-upload-pack", this.fetcher);
    const target = new Map<string, string>();
    for (const ref of remote.refs) {
      if (isValidRef(ref.name)) {
        target.set(ref.name, ref.sha);
      }
    }
    const wants = [...new Set(target.values())].filter((sha) => !objects.has(sha));
    // A fetch that stopped between rounds left commits without parents; finish the part the
    // current tips need first.
    const tips = [...new Set(target.values())];
    const boundary = this.reachedBoundary(tips);
    if (wants.length > 0 || boundary.size > 0) {
      // Local refs always have their whole history here, so their tips are safe haves.
      const haves = refs
        .list()
        .map((ref) => ref.sha)
        .filter((sha) => objects.has(sha));
      await this.fetchObjects(wants, haves, boundary);
      if (this.reachedBoundary(tips).size > 0) {
        throw new GitError("the full remote history is still incomplete", 502);
      }
    }
    const updates = this.storage.transaction(() => {
      const changed: RefUpdate[] = [];
      for (const [name, sha] of target) {
        const current = refs.get(name);
        if (current !== sha && current === before.get(name) && !this.pushing.has(name)) {
          refs.set(name, sha);
          changed.push({ ref: name, old: current ?? ZERO_SHA, new: sha });
        }
      }
      for (const ref of refs.list()) {
        const settled = ref.sha === before.get(ref.name) && !this.pushing.has(ref.name);
        if (!target.has(ref.name) && settled) {
          refs.delete(ref.name);
          changed.push({ ref: ref.name, old: ref.sha, new: ZERO_SHA });
        }
      }
      if (remote.head !== undefined && refs.get(remote.head) !== undefined) {
        if (refs.head() !== remote.head) {
          refs.setHead(remote.head);
        }
      } else if (refs.get(refs.head()) === undefined) {
        const branch = refs.list().find((ref) => ref.name.startsWith("refs/heads/"));
        if (branch !== undefined) {
          refs.setHead(branch.name);
        }
      }
      return changed;
    });
    return updates;
  }

  /**
   * Pushes the public projection: target refs = repo.refs("public"); current = lsRemote(public,
   * receive-pack). Sends create/update/delete commands for the differences, with a pack of the
   * objects reachable from the new tips and not from the current public tips. No-op when nothing
   * differs. Runs one at a time, so a publish never races another one.
   */
  publish(): Promise<RefUpdate[]> {
    const run = this.publishing.then(() => this.runPublish());
    this.publishing = run.catch(() => undefined);
    return run;
  }

  private async runPublish(): Promise<RefUpdate[]> {
    const remote = await lsRemote(this.remotes.public, "git-receive-pack", this.fetcher);
    const current = new Map<string, string>();
    for (const ref of remote.refs) {
      if (isValidRef(ref.name)) {
        current.set(ref.name, ref.sha);
      }
    }
    const target = this.repo.refs("public");
    const commands: Command[] = [];
    for (const ref of target) {
      const old = current.get(ref.name) ?? ZERO_SHA;
      // A ref that is still being pushed may yet be rejected; its push publishes it.
      if (old !== ref.sha && !this.pushing.has(ref.name)) {
        commands.push({ ref: ref.name, old, new: ref.sha });
      }
    }
    const kept = new Set(target.map((ref) => ref.name));
    for (const [name, sha] of current) {
      if (!kept.has(name) && !this.pushing.has(name)) {
        commands.push({ ref: name, old: sha, new: ZERO_SHA });
      }
    }
    if (commands.length === 0) {
      return [];
    }
    const tips = [...new Set(commands.map((command) => command.new))].filter(
      (sha) => sha !== ZERO_SHA,
    );
    let pack = new Uint8Array();
    if (tips.length > 0) {
      const haves = remote.refs.map((ref) => ref.sha);
      pack = await this.repo.pack(planPack(this.storage.objects, tips, haves).objects);
    }
    await sendPack(this.remotes.public, commands, pack, this.fetcher);
    return commands;
  }

  /**
   * For server-side writes: `update` was already applied to local refs by GitRepo (merge,
   * commitFiles, updateRef). Pushes it to the full remote with a pack of the new objects
   * (reachable from update.new, not from update.old or the remote's other tips). It reads the
   * remote's refs first and fails with GitError 409 when update.ref is no longer at update.old. On
   * failure, restores the local ref to update.old (when it still points at update.new) and
   * rethrows. It does not publish; the caller publishes after a successful push.
   */
  async pushLocal(update: RefUpdate): Promise<void> {
    this.pushing.set(update.ref, (this.pushing.get(update.ref) ?? 0) + 1);
    try {
      const remote = await lsRemote(this.remotes.full, "git-receive-pack", this.fetcher);
      const current = remote.refs.find((ref) => ref.name === update.ref)?.sha ?? ZERO_SHA;
      if (current !== update.old) {
        // Fail before uploading a pack the remote would reject anyway.
        throw new GitError(
          `${update.ref} moved to ${current} on the full remote; fetch first`,
          409,
        );
      }
      let pack = new Uint8Array();
      if (update.new !== ZERO_SHA) {
        const haves = [update.old, ...remote.refs.map((ref) => ref.sha)];
        pack = await this.repo.pack(planPack(this.storage.objects, [update.new], haves).objects);
      }
      await sendPack(this.remotes.full, [update], pack, this.fetcher);
    } catch (error) {
      this.restore(update);
      throw error;
    } finally {
      const left = (this.pushing.get(update.ref) ?? 1) - 1;
      if (left === 0) {
        this.pushing.delete(update.ref);
      } else {
        this.pushing.set(update.ref, left);
      }
    }
  }

  /** Puts a ref back to `update.old`, unless something else has moved it since `update`. */
  private restore(update: RefUpdate): void {
    if ((this.storage.refs.get(update.ref) ?? ZERO_SHA) === update.new) {
      this.repo.applyUpdates([{ ref: update.ref, old: update.new, new: update.old }]);
    }
  }
}
