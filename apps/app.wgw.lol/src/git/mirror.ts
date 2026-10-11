import { ZERO_SHA } from "./objects";
import { parsePack } from "./pack";
import type { Command } from "./protocol";
import { fetchPack, lsRemote, type Remote, sendPack } from "./remote";
import { GitError, type GitRepo, isValidRef, type RefUpdate, type Storage } from "./repo";
import { planPack } from "./walk";

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
  private syncing: Promise<RefUpdate[]> | undefined;
  private queued: Promise<RefUpdate[]> | undefined;
  private publishing: Promise<unknown> = Promise.resolve();
  /** Refs with a pushLocal in flight, and how many. Sync and publish leave them to that push. */
  private readonly pushing = new Map<string, number>();

  constructor(
    readonly repo: GitRepo,
    readonly storage: Storage,
    readonly remotes: Remotes,
    private readonly fetcher?: typeof fetch,
  ) {}

  /**
   * Fetches objects and refs from the full remote into storage, makes local refs equal the remote
   * refs (heads and tags only; deletes refs the remote no longer has; sets HEAD from the
   * advertisement's symref), then calls publish(). A call during a run waits for one more run that
   * starts after the current one, so it always sees remote changes made before the call. Returns the
   * local ref changes.
   */
  sync(): Promise<RefUpdate[]> {
    if (this.syncing === undefined) {
      this.syncing = this.runSync().finally(() => {
        this.syncing = undefined;
      });
      return this.syncing;
    }
    // A run in progress may have read the remote refs before the change this caller wants to
    // see, so queue one more run after it. Callers that arrive meanwhile share that run.
    this.queued ??= this.syncing
      .catch(() => undefined)
      .then(() => {
        this.queued = undefined;
        return this.sync();
      });
    return this.queued;
  }

  private async runSync(): Promise<RefUpdate[]> {
    const { objects, refs } = this.storage;
    // Refs a server-side write moves while this runs belong to that write; the sync leaves them.
    const before = new Map(refs.list().map((ref) => [ref.name, ref.sha]));
    const remote = await lsRemote(this.remotes.full, "git-upload-pack", this.fetcher);
    const target = new Map<string, string>();
    for (const ref of remote.refs) {
      if (isValidRef(ref.name)) {
        target.set(ref.name, ref.sha);
      }
    }
    const wants = [...new Set(target.values())].filter((sha) => !objects.has(sha));
    if (wants.length > 0) {
      const haves = refs
        .list()
        .map((ref) => ref.sha)
        .filter((sha) => objects.has(sha));
      const pack = await fetchPack(this.remotes.full, wants, haves, this.fetcher);
      if (pack.length > 0) {
        await this.storage.saveObjects(parsePack(pack, (sha) => objects.read(sha)));
      }
      const missing = wants.find((sha) => !objects.has(sha));
      if (missing !== undefined) {
        throw new GitError(`the full remote did not send ${missing}`, 502);
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
    await this.publish();
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
   * rethrows. On success, calls publish(), whose errors propagate with the local ref kept.
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
    // The write landed in the full repo. A failed publish only delays the public view: the next
    // sync publishes again, so it must not turn a successful write into an error.
    try {
      await this.publish();
    } catch (error) {
      console.error(`publish after ${update.ref} failed`, error);
    }
  }

  /** Puts a ref back to `update.old`, unless something else has moved it since `update`. */
  private restore(update: RefUpdate): void {
    if ((this.storage.refs.get(update.ref) ?? ZERO_SHA) === update.new) {
      this.repo.applyUpdates([{ ref: update.ref, old: update.new, new: update.old }]);
    }
  }
}
