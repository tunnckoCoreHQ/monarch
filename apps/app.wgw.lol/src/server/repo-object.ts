import { DurableObject } from "cloudflare:workers";

import { sha1Hex, utf8 } from "../git/bytes";
import { Mirror } from "../git/mirror";
import {
  type GitObject,
  objectHash,
  type ObjectType,
  type Person,
  TYPE_CODE,
  TYPE_NAME,
  ZERO_SHA,
} from "../git/objects";
import type { PackedObject } from "../git/pack";
import { rulesOf } from "../git/projection";
import type { Remote } from "../git/remote";
import { GitError, GitRepo, type RefUpdate, type Storage, type View } from "../git/repo";
import { RULES_FILE } from "../git/rules";
import type { RawObject } from "../git/store";
import { type FileChange, listFiles } from "../git/tree";
import { deflate, inflate } from "../git/zlib";
import { eventStatement, findRepoById } from "./db";
import type { Env } from "./env";
import { subscribePushes, unsubscribe } from "./events";
import { guard, type Result } from "./result";
import { enqueueIndex, type IndexResult, indexRepo } from "./search";
import { now } from "./util";

// SQLite rows and values are capped at 2 MB, so larger zlib streams go to R2.
const MAX_INLINE = 1_000_000;
const CACHE_LIMIT = 4000;
// The app's own Artifacts tokens; a fresh one is minted when less than 10 minutes remain.
const TOKEN_TTL = 3600;
const TOKEN_MARGIN_MS = 10 * 60 * 1000;
// Reads sync from Artifacts first when the mirror is older than this, which catches direct pushes.
const FRESH_MS = 15_000;
// The proxy says who is pushing before it forwards a push; an unused claim expires after this.
const CLAIM_MS = 60 * 60 * 1000;
// Pushes that could not be recorded in D1 are tried again from an alarm after this.
const RECORD_RETRY_MS = 30_000;
// A failed push subscription is tried again after this.
const SUBSCRIBE_RETRY_MS = 10 * 60 * 1000;
const RECORD_BATCH = 100;

export interface PushCommand {
  ref: string;
  new: string;
}

// A type, not an interface: SQL row types need an index signature.
type PushRow = {
  id: number;
  run: number;
  ref: string;
  old: string;
  new: string;
  actor_id: string | null;
};

export type Target = "full" | "public";
export type Scope = "read" | "write";

export interface SyncResult {
  updates: RefUpdate[];
  /** Why the public projection could not be published, or null. */
  publishError: string | null;
}

export interface GitAccess {
  remote: string;
  token: string;
  scope: Scope;
  expires_at: string;
}

interface CachedToken {
  token: string;
  expires: number;
}

function artifactsCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

export class Repo extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly cache = new Map<string, GitObject>();
  private readonly repo: GitRepo;
  private readonly tokens = new Map<string, CachedToken>();
  private readonly minting = new Map<string, Promise<CachedToken>>();
  private mirror: Mirror | undefined;
  private writes: Promise<unknown> = Promise.resolve();
  private recording: Promise<void> | undefined;
  private indexing: Promise<Result<IndexResult>> | undefined;
  private indexQueued: Promise<Result<IndexResult>> | undefined;
  private subscribing: Promise<void> | undefined;
  private repoId = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS objects (sha TEXT PRIMARY KEY, type INTEGER NOT NULL, size INTEGER NOT NULL, zdata BLOB);
      CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, sha TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projected_commits (sha TEXT PRIMARY KEY, projected TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projected_trees (key TEXT PRIMARY KEY, projected TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shallow (sha TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS pushes (id INTEGER PRIMARY KEY AUTOINCREMENT, run INTEGER NOT NULL, ref TEXT NOT NULL, old TEXT NOT NULL, new TEXT NOT NULL, actor_id TEXT);
      DROP TABLE IF EXISTS push_claims;
      CREATE TABLE IF NOT EXISTS claims (id TEXT NOT NULL, ref TEXT NOT NULL, new TEXT NOT NULL, actor_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (id, ref));
    `);
    this.repoId = this.meta("repo_id") ?? "";
    this.repo = new GitRepo(this.storage());
  }

  private meta(key: string): string | undefined {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
      .toArray()[0];
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private remember(sha: string, object: GitObject): void {
    if (this.cache.size >= CACHE_LIMIT) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(sha, object);
  }

  private storage(): Storage {
    const sql = this.sql;
    const raw = (sha: string): RawObject | undefined => {
      const row = sql
        .exec<{ type: number; size: number; zdata: ArrayBuffer | null }>(
          "SELECT type, size, zdata FROM objects WHERE sha = ?",
          sha,
        )
        .toArray()[0];
      if (row === undefined) {
        return undefined;
      }
      return {
        type: TYPE_NAME[row.type],
        size: row.size,
        zdata: row.zdata === null ? undefined : new Uint8Array(row.zdata),
      };
    };
    const insert = (sha: string, type: ObjectType, size: number, zdata: Uint8Array | null) => {
      sql.exec(
        "INSERT OR IGNORE INTO objects (sha, type, size, zdata) VALUES (?, ?, ?, ?)",
        sha,
        TYPE_CODE[type],
        size,
        zdata,
      );
    };
    return {
      objects: {
        read: (sha) => {
          const cached = this.cache.get(sha);
          if (cached !== undefined) {
            return cached;
          }
          const row = raw(sha);
          if (row?.zdata === undefined) {
            return undefined;
          }
          const object = { type: row.type, content: inflate(row.zdata) };
          this.remember(sha, object);
          return object;
        },
        raw,
        has: (sha) =>
          this.cache.has(sha) ||
          sql.exec("SELECT 1 FROM objects WHERE sha = ?", sha).toArray().length > 0,
        write: (type, content) => {
          const sha = objectHash(type, content);
          if (raw(sha) === undefined) {
            const zdata = deflate(content);
            if (zdata.length > MAX_INLINE) {
              // Large blobs must reach R2 first, through saveObjects; see commitFiles.
              throw new GitError(`object ${sha} is too large to write inline`, 413);
            }
            insert(sha, type, content.length, zdata);
          }
          this.remember(sha, { type, content });
          return sha;
        },
      },
      refs: {
        list: () =>
          sql
            .exec<{ name: string; sha: string }>("SELECT name, sha FROM refs ORDER BY name")
            .toArray(),
        get: (name) =>
          sql.exec<{ sha: string }>("SELECT sha FROM refs WHERE name = ?", name).toArray()[0]?.sha,
        set: (name, sha) => {
          sql.exec(
            "INSERT INTO refs (name, sha) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET sha = excluded.sha",
            name,
            sha,
          );
        },
        delete: (name) => {
          sql.exec("DELETE FROM refs WHERE name = ?", name);
        },
        head: () => this.meta("head") ?? "refs/heads/main",
        setHead: (name) => this.setMeta("head", name),
      },
      memo: {
        getCommit: (sha) =>
          sql
            .exec<{ projected: string }>(
              "SELECT projected FROM projected_commits WHERE sha = ?",
              sha,
            )
            .toArray()[0]?.projected,
        setCommit: (sha, projected) => {
          sql.exec(
            "INSERT OR REPLACE INTO projected_commits (sha, projected) VALUES (?, ?)",
            sha,
            projected,
          );
        },
        getTree: (key) =>
          sql
            .exec<{ projected: string }>(
              "SELECT projected FROM projected_trees WHERE key = ?",
              sha1Hex([utf8(key)]),
            )
            .toArray()[0]?.projected,
        setTree: (key, projected) => {
          sql.exec(
            "INSERT OR REPLACE INTO projected_trees (key, projected) VALUES (?, ?)",
            sha1Hex([utf8(key)]),
            projected,
          );
        },
      },
      loadExternal: async (sha) => {
        const object = await this.env.GIT.get(`objects/${this.repoId}/${sha}`);
        if (object === null) {
          throw new GitError(`missing object ${sha} in R2`, 500);
        }
        return new Uint8Array(await object.arrayBuffer());
      },
      saveObjects: async (objects: PackedObject[]) => {
        const large = objects.filter(
          (object) => object.zdata.length > MAX_INLINE && !raw(object.sha),
        );
        await Promise.all(
          large.map((object) =>
            this.env.GIT.put(`objects/${this.repoId}/${object.sha}`, object.zdata),
          ),
        );
        const outside = new Set(large.map((object) => object.sha));
        this.ctx.storage.transactionSync(() => {
          for (const object of objects) {
            insert(
              object.sha,
              object.type,
              object.content.length,
              outside.has(object.sha) ? null : object.zdata,
            );
          }
        });
      },
      shallow: {
        list: () =>
          sql
            .exec<{ sha: string }>("SELECT sha FROM shallow")
            .toArray()
            .map((row) => row.sha),
        add: (sha) => {
          sql.exec("INSERT OR IGNORE INTO shallow (sha) VALUES (?)", sha);
        },
        delete: (sha) => {
          sql.exec("DELETE FROM shallow WHERE sha = ?", sha);
        },
      },
      transaction: (run) => this.ctx.storage.transactionSync(run),
    };
  }

  /** The Artifacts repo name of the full repo or its public projection. */
  private artifactsName(target: Target): string {
    if (this.repoId === "") {
      throw new GitError("the repository is not set up", 500);
    }
    return target === "full" ? this.repoId : `${this.repoId}.public`;
  }

  private remoteUrl(target: Target): string {
    const remote = this.meta(`remote_${target}`);
    if (remote === undefined) {
      throw new GitError("the repository has no Artifacts remote yet", 409);
    }
    return remote;
  }

  /**
   * Mints an Artifacts token. The handle is an RPC stub; dispose it when the runtime supports it.
   * Artifacts sometimes answers a burst of token requests with an internal error, so retry twice.
   */
  private async mint(target: Target, scope: Scope, ttl: number) {
    for (let attempt = 0; ; attempt++) {
      try {
        const handle = await this.env.ARTIFACTS.get(this.artifactsName(target));
        try {
          return await handle.createToken(scope, ttl);
        } finally {
          const dispose: unknown = Reflect.get(handle, Symbol.dispose);
          if (typeof dispose === "function") {
            dispose.call(handle);
          }
        }
      } catch (error) {
        const code = artifactsCode(error);
        const transient = code === undefined || code === "INTERNAL_ERROR";
        if (!transient || attempt >= 2) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }

  /** A cached token for the app's own git traffic. Concurrent callers share one mint. */
  private token(target: Target, scope: Scope): Promise<CachedToken> {
    const key = `${target}:${scope}`;
    const cached = this.tokens.get(key);
    if (cached !== undefined && cached.expires - Date.now() > TOKEN_MARGIN_MS) {
      return Promise.resolve(cached);
    }
    let pending = this.minting.get(key);
    if (pending === undefined) {
      pending = this.mint(target, scope, TOKEN_TTL)
        .then((minted) => {
          const fresh = { token: minted.plaintext, expires: Date.parse(minted.expiresAt) };
          this.tokens.set(key, fresh);
          return fresh;
        })
        .finally(() => this.minting.delete(key));
      this.minting.set(key, pending);
    }
    return pending;
  }

  private getMirror(): Mirror {
    if (this.mirror === undefined) {
      const remote = (target: Target): Remote => ({
        url: this.remoteUrl(target),
        token: async () => (await this.token(target, "write")).token,
      });
      this.mirror = new Mirror(
        this.repo,
        this.repo.storage,
        { full: remote("full"), public: remote("public") },
        undefined,
        { onRefresh: (updates) => this.queuePushes(updates) },
      );
    }
    return this.mirror;
  }

  /** Records the Artifacts remotes after the repos exist. */
  private async setUp(repoId: string, full: string, defaultBranch: string): Promise<void> {
    this.repoId = repoId;
    this.setMeta("repo_id", repoId);
    this.setMeta("head", `refs/heads/${defaultBranch}`);
    this.setMeta("remote_full", full);
    const created = await this.env.ARTIFACTS.create(this.artifactsName("public"), {
      description: "Public projection, written by app.wgw.lol",
      setDefaultBranch: defaultBranch,
    });
    this.setMeta("remote_public", created.remote);
    await this.ensureSubscribed();
    this.mirror = undefined;
  }

  /**
   * Subscribes the events queue to pushes on the full repo, once. Until that works, a direct push
   * reaches the mirror on the next read instead, within 15 seconds. A failure is tried again from
   * the next sync or read after SUBSCRIBE_RETRY_MS, and from the hourly check.
   */
  private ensureSubscribed(): Promise<void> {
    if (
      this.meta("push_subscription") !== undefined ||
      this.meta("remote_full") === undefined ||
      Date.now() < Number(this.meta("subscribe_after") ?? 0)
    ) {
      return Promise.resolve();
    }
    this.subscribing ??= (async () => {
      try {
        this.setMeta(
          "push_subscription",
          await subscribePushes(this.env, this.artifactsName("full")),
        );
        this.sql.exec("DELETE FROM meta WHERE key = 'subscribe_after'");
      } catch (error) {
        console.error(`could not subscribe to pushes on ${this.repoId}`, error);
        this.setMeta("subscribe_after", String(Date.now() + SUBSCRIBE_RETRY_MS));
      }
    })().finally(() => {
      this.subscribing = undefined;
    });
    return this.subscribing;
  }

  /** The hourly check: subscribes repos that have no push subscription yet. */
  checkSubscription(): Promise<Result<boolean>> {
    return guard(async () => {
      await this.ensureSubscribed();
      return this.meta("push_subscription") !== undefined;
    });
  }

  /**
   * Says who is about to push which refs. The git proxy calls this before it forwards a push, so
   * whichever sync records the push, from the proxy or from the queue, knows the pusher. Returns
   * the claim's id; each push request has its own.
   */
  claimPush(actorId: string, commands: PushCommand[]): Promise<Result<string>> {
    return guard(() => {
      const id = crypto.randomUUID();
      const at = Date.now();
      this.sql.exec("DELETE FROM claims WHERE at < ?", at - CLAIM_MS);
      for (const command of commands) {
        this.sql.exec(
          "INSERT INTO claims (id, ref, new, actor_id, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id, ref) DO NOTHING",
          id,
          command.ref,
          command.new,
          actorId,
          at,
        );
      }
      return id;
    });
  }

  /**
   * Drops what is left of one push request's claim. The proxy calls this after its own sync, which
   * has seen every update of that push that Artifacts accepted, so what remains belongs to updates
   * Artifacts refused. Claims of other requests, a retry of the same push among them, stay.
   */
  releaseClaims(id: string): Promise<Result<null>> {
    return guard(() => {
      this.sql.exec("DELETE FROM claims WHERE id = ?", id);
      return null;
    });
  }

  /** Runs in the refresh's ref transaction, so a moved ref always has its row here. */
  private queuePushes(updates: RefUpdate[]): void {
    const run = Number(this.meta("push_run") ?? 0) + 1;
    this.setMeta("push_run", String(run));
    for (const update of updates) {
      // The oldest fresh claim: when a push is retried, the first request is the one that landed.
      const claim = this.sql
        .exec<{ actor_id: string }>(
          "DELETE FROM claims WHERE rowid = (SELECT rowid FROM claims WHERE ref = ? AND new = ? AND at >= ? ORDER BY at LIMIT 1) RETURNING actor_id",
          update.ref,
          update.new,
          Date.now() - CLAIM_MS,
        )
        .toArray()[0];
      this.sql.exec(
        "INSERT INTO pushes (run, ref, old, new, actor_id) VALUES (?, ?, ?, ?, ?)",
        run,
        update.ref,
        update.old,
        update.new,
        claim?.actor_id ?? null,
      );
    }
  }

  /**
   * Records queued pushes in D1: the push events, `pushed_at`, and the default branch. A row
   * leaves the queue only after D1 has it. On a failure an alarm tries again, and each event's id
   * comes from its refresh and pusher, so a retry never records a push twice. One run at a time; a run keeps
   * going while rows remain, so rows queued during it are not left behind.
   */
  private recordPushes(): Promise<void> {
    this.recording ??= this.runRecord().finally(() => {
      this.recording = undefined;
    });
    return this.recording;
  }

  private async runRecord(): Promise<void> {
    try {
      for (;;) {
        const rows = this.sql
          .exec<PushRow>("SELECT * FROM pushes ORDER BY id LIMIT ?", RECORD_BATCH)
          .toArray();
        if (rows.length === 0) {
          return;
        }
        const last = rows.at(-1)!.id;
        const repo = await findRepoById(this.env, this.repoId);
        // An import or fork records itself once the RepoReady workflow marks it ready.
        if (repo !== null && repo.status === "ready") {
          // One event per refresh and pusher, keyed by its first row. A retry sees the same groups:
          // rows queued later belong to later refreshes.
          const groups: PushRow[][] = [];
          for (const row of rows) {
            const group = groups.at(-1);
            if (
              group !== undefined &&
              group[0].run === row.run &&
              group[0].actor_id === row.actor_id
            ) {
              group.push(row);
            } else {
              groups.push([row]);
            }
          }
          const head = this.repo.storage.refs.head().replace(/^refs\/heads\//, "");
          await this.env.DB.batch([
            this.env.DB.prepare(
              "UPDATE repos SET pushed_at = ?, default_branch = ? WHERE id = ?",
            ).bind(now(), head, repo.id),
            ...groups.map((group) =>
              eventStatement(
                this.env,
                `evt_push_${repo.id}_${group[0].id}`,
                repo.id,
                group[0].actor_id,
                "push",
                { updates: group.map(({ ref, old, new: sha }) => ({ ref, old, new: sha })) },
              ),
            ),
          ]);
          for (const group of groups) {
            this.env.METRICS.writeDataPoint({
              blobs: ["push", `${repo.owner}/${repo.name}`],
              doubles: [group.length],
              indexes: [repo.id],
            });
          }
          if (rows.some((row) => row.ref === `refs/heads/${head}`)) {
            // Search covers the default branch tip. A failed enqueue waits for the next push or
            // the hourly check, and must not hold the push rows back.
            await enqueueIndex(this.env, repo.id).catch((error: unknown) => {
              console.error(`could not enqueue a search index for ${repo.id}`, error);
            });
          }
        }
        this.sql.exec("DELETE FROM pushes WHERE id <= ?", last);
      }
    } catch (error) {
      console.error(`could not record pushes for ${this.repoId}`, error);
      await this.ctx.storage.setAlarm(Date.now() + RECORD_RETRY_MS);
    }
  }

  /**
   * Runs the search indexer for this repository. Runs never overlap. A call during a run waits for
   * one more run after it, which sees what the call was made for; calls meanwhile share that run.
   */
  index(): Promise<Result<IndexResult>> {
    if (this.indexing === undefined) {
      this.indexing = guard(() => indexRepo(this.env, this.repoId)).finally(() => {
        this.indexing = undefined;
      });
      return this.indexing;
    }
    this.indexQueued ??= this.indexing.then(() => {
      this.indexQueued = undefined;
      return this.index();
    });
    return this.indexQueued;
  }

  override async alarm(): Promise<void> {
    await this.recordPushes();
    await this.ensureSubscribed();
  }

  /** Creates the empty full repo and its public projection in Artifacts. */
  create(repoId: string, defaultBranch: string, description: string): Promise<Result<null>> {
    return guard(async () => {
      this.repoId = repoId;
      const created = await this.env.ARTIFACTS.create(repoId, {
        description,
        setDefaultBranch: defaultBranch,
      });
      await this.setUp(repoId, created.remote, defaultBranch);
      this.setMeta("synced_at", String(Date.now()));
      return null;
    });
  }

  /** Starts an Artifacts import of one branch. The RepoReady workflow syncs once it finishes. */
  importFrom(repoId: string, url: string, branch: string | undefined): Promise<Result<null>> {
    return guard(async () => {
      this.repoId = repoId;
      let imported;
      try {
        imported = await this.env.ARTIFACTS.import({
          source: { url, branch },
          target: { name: repoId, opts: { description: `Imported from ${url}` } },
        });
      } catch (error) {
        const code = artifactsCode(error);
        const reasons: Record<string, string> = {
          INVALID_URL: "that URL is not a git repository",
          INVALID_INPUT: "import from an https:// git remote",
          REMOTE_AUTH_REQUIRED:
            "the remote needs authentication; only public remotes can be imported",
          NOT_FOUND: "the remote repository does not exist",
          UPSTREAM_UNAVAILABLE: "the remote did not answer",
          MEMORY_LIMIT: "the repository is too large to import",
        };
        if (code !== undefined && code in reasons) {
          throw new GitError(reasons[code], 400);
        }
        throw error;
      }
      await this.setUp(repoId, imported.remote, imported.defaultBranch);
      return null;
    });
  }

  /** Forks another wgw repo in Artifacts. Outsiders fork its public projection. */
  forkFrom(
    repoId: string,
    sourceId: string,
    view: View,
    defaultBranch: string,
  ): Promise<Result<null>> {
    return guard(async () => {
      this.repoId = repoId;
      const sourceName = view === "full" ? sourceId : `${sourceId}.public`;
      const source = await this.env.ARTIFACTS.get(sourceName);
      const forked = await source.fork(repoId, { defaultBranchOnly: false });
      await this.setUp(repoId, forked.remote, forked.defaultBranch || defaultBranch);
      return null;
    });
  }

  /** True when the full Artifacts repo has finished importing or forking. */
  isReady(): Promise<Result<boolean>> {
    return guard(async () => {
      try {
        const handle = await this.env.ARTIFACTS.get(this.artifactsName("full"));
        const dispose: unknown = Reflect.get(handle, Symbol.dispose);
        if (typeof dispose === "function") {
          dispose.call(handle);
        }
        return true;
      } catch (error) {
        const code = artifactsCode(error);
        if (code === "IMPORT_IN_PROGRESS" || code === "FORK_IN_PROGRESS") {
          return false;
        }
        throw error;
      }
    });
  }

  /**
   * Fetches from the full Artifacts repo, then publishes the public projection. A publish failure
   * does not fail the call: the members' mirror is current, and the public repo keeps its last,
   * still filtered, state until the next sync publishes again.
   */
  sync(): Promise<Result<SyncResult>> {
    return guard(async () => {
      const updates = await this.getMirror().refresh();
      this.setMeta("synced_at", String(Date.now()));
      await this.recordPushes();
      await this.ensureSubscribed();
      return { updates, publishError: await this.publish() };
    });
  }

  /**
   * Publishes the public projection and keeps the repo's note in D1 in step with the result: a
   * failure shows "public view not published" on the repo page, and the next success clears it.
   * Returns the failure, or null.
   */
  private async publish(): Promise<string | null> {
    let failure: string | null = null;
    try {
      await this.getMirror().publish();
    } catch (error) {
      console.error(`publish failed for ${this.repoId}`, error);
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure !== (this.meta("publish_error") ?? null)) {
      try {
        // Only a ready repo shows the note; the RepoReady workflow writes it for the others.
        await this.env.DB.prepare(
          "UPDATE repos SET status_detail = ? WHERE id = ? AND status = 'ready'",
        )
          .bind(
            failure === null ? null : `public view not published: ${failure}`.slice(0, 500),
            this.repoId,
          )
          .run();
        // Recorded only after D1 took the note, so a failed update is tried again next time.
        if (failure === null) {
          this.sql.exec("DELETE FROM meta WHERE key = 'publish_error'");
        } else {
          this.setMeta("publish_error", failure);
        }
      } catch (error) {
        // The note is informational; it must never turn a completed write into an error.
        console.error(`could not update the publish note for ${this.repoId}`, error);
      }
    }
    return failure;
  }

  /** Syncs before a read when the mirror may be stale. A failed sync keeps the last mirror. */
  private async fresh(): Promise<void> {
    const synced = Number(this.meta("synced_at") ?? 0);
    if (Date.now() - synced < FRESH_MS || this.meta("remote_full") === undefined) {
      return;
    }
    const result = await this.sync();
    if (!result.ok) {
      console.error(`mirror sync failed for ${this.repoId}: ${result.error}`);
    }
  }

  /**
   * Runs server-side writes one at a time: refresh from the full repo, apply locally, push to
   * Artifacts. It does not wait for the public view, so a broken projection cannot block a write
   * that fixes it.
   */
  private write<T extends { update: RefUpdate }>(run: () => T): Promise<Result<T>> {
    const next = this.writes.then(() =>
      guard(async () => {
        const mirror = this.getMirror();
        await mirror.refresh();
        // Pushes the refresh found are someone else's; this write records its own update.
        await this.recordPushes();
        const result = run();
        await mirror.pushLocal(result.update);
        // The write landed; a failed publish only delays the public view and is noted on the repo.
        await this.publish();
        this.setMeta("synced_at", String(Date.now()));
        return result;
      }),
    );
    this.writes = next;
    return next;
  }

  /** Remote and token for the proxy (cached) or for a caller who wants direct access (fresh). */
  gitAccess(target: Target, scope: Scope, direct: boolean): Promise<Result<GitAccess>> {
    return guard(async () => {
      if (target === "public" && scope === "write") {
        throw new GitError("the public projection is written only by the app", 403);
      }
      if (direct) {
        const minted = await this.mint(target, scope, TOKEN_TTL);
        return {
          remote: this.remoteUrl(target),
          token: minted.plaintext,
          scope,
          expires_at: minted.expiresAt,
        };
      }
      const cached = await this.token(target, scope);
      return {
        remote: this.remoteUrl(target),
        token: cached.token,
        scope,
        expires_at: new Date(cached.expires).toISOString(),
      };
    });
  }

  refs(view: View) {
    return guard(async () => {
      await this.fresh();
      return { refs: this.repo.refs(view), head: this.repo.storage.refs.head() };
    });
  }

  tree(view: View, rev: string, path: string) {
    return guard(async () => {
      await this.fresh();
      return {
        ...this.repo.tree(view, rev, path),
        readme: path === "" ? this.repo.readmeName(view, rev) : undefined,
      };
    });
  }

  blob(view: View, rev: string, path: string) {
    return guard(async () => {
      await this.fresh();
      return this.repo.blob(view, rev, path);
    });
  }

  log(view: View, rev: string, limit: number, path?: string) {
    return guard(async () => {
      await this.fresh();
      return this.repo.log(view, rev, limit, path);
    });
  }

  showCommit(view: View, rev: string) {
    return guard(async () => {
      await this.fresh();
      return this.repo.showCommit(view, rev);
    });
  }

  compare(view: View, base: string, head: string) {
    return guard(async () => {
      await this.fresh();
      return this.repo.compare(view, base, head);
    });
  }

  resolve(view: View, rev: string) {
    return guard(async () => {
      await this.fresh();
      return this.repo.resolve(view, rev) ?? null;
    });
  }

  merge(base: string, head: string, message: string, person: Person) {
    return this.write(() => this.repo.merge(base, head, message, person));
  }

  async commitFiles(
    branch: string,
    expected: string | undefined,
    message: string,
    person: Person,
    files: FileChange[],
    from?: string,
  ) {
    // Store large blobs the way a sync does, in R2, before the synchronous commit writes them.
    const large: PackedObject[] = [];
    for (const file of files) {
      if (file.content === null) {
        continue;
      }
      const zdata = deflate(file.content);
      if (zdata.length > MAX_INLINE) {
        // The rules reader reads only inline objects.
        if (file.path === RULES_FILE) {
          return guard(() => {
            throw new GitError(`${RULES_FILE} is too large`, 413);
          });
        }
        large.push({
          sha: objectHash("blob", file.content),
          type: "blob",
          content: file.content,
          zdata,
        });
      }
    }
    if (large.length > 0) {
      await this.repo.storage.saveObjects(large);
    }
    return this.write(() => this.repo.commitFiles(branch, expected, message, person, files, from));
  }

  createBranch(name: string, from: string) {
    return this.write(() => {
      const sha = this.repo.resolve("full", from);
      if (sha === undefined) {
        throw new GitError(`unknown revision ${from}`, 404);
      }
      return { update: this.repo.updateRef(`refs/heads/${name}`, ZERO_SHA, sha) };
    });
  }

  deleteBranch(name: string) {
    return this.write(() => {
      const ref = `refs/heads/${name}`;
      const sha = this.repo.storage.refs.get(ref);
      if (sha === undefined) {
        throw new GitError(`unknown branch ${name}`, 404);
      }
      return { update: this.repo.updateRef(ref, sha, ZERO_SHA) };
    });
  }

  /** The `.gitprivate` rules at a revision, and whether the public view of it differs. */
  privacy(rev: string) {
    return guard(() => {
      const sha = this.repo.resolve("full", rev);
      if (sha === undefined) {
        return { rules: "", hidden: false };
      }
      const tree = this.repo.readCommit(sha).tree;
      return { rules: rulesOf(this.repo.objects, tree).key, hidden: !this.repo.isPublic(sha) };
    });
  }

  /** The default branch the mirror saw in the full repo's advertisement. */
  head() {
    return guard(() => this.repo.storage.refs.head());
  }

  // Code search reads. The indexer in search.ts lists a commit once, then reads the blobs it needs.

  /** Every file at a commit of the full repo, with its blob hash and size. */
  searchFiles(rev: string) {
    return guard(() => {
      const sha = this.repo.resolve("full", rev);
      if (sha === undefined) {
        throw new GitError(`unknown revision ${rev}`, 404);
      }
      return listFiles(this.repo.objects, this.repo.readCommit(sha).tree);
    });
  }

  /** Blob contents by hash, from the full repo. A blob kept in R2 comes back as null. */
  searchBlobs(shas: string[]) {
    return guard(() =>
      shas.map((sha) => {
        const object = this.repo.objects.read(sha);
        return object?.type === "blob" ? object.content : null;
      }),
    );
  }

  /**
   * Deletes both Artifacts repos, then the mirror's R2 objects and the mirror. A failed Artifacts
   * delete stops here with an error, so the D1 record stays and the delete can be retried.
   */
  destroy(): Promise<Result<null>> {
    return guard(async () => {
      if (this.repoId !== "") {
        for (const target of ["full", "public"] as const) {
          // `delete` returns false for a repo that is already gone, which is fine here.
          await this.env.ARTIFACTS.delete(this.artifactsName(target));
        }
      }
      const subscription = this.meta("push_subscription");
      if (subscription !== undefined) {
        try {
          await unsubscribe(this.env, subscription);
        } catch (error) {
          // A subscription to a deleted repo delivers nothing, so a failure here only leaves clutter.
          console.error(`could not delete push subscription ${subscription}`, error);
        }
      }
      const prefix = `objects/${this.repoId}/`;
      // Each listing returns one page. Deleting it moves the next keys to the front.
      for (;;) {
        const listed = await this.env.GIT.list({ prefix });
        if (listed.objects.length > 0) {
          await this.env.GIT.delete(listed.objects.map((object) => object.key));
        }
        if (!listed.truncated) {
          break;
        }
      }
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.repoId = "";
      this.mirror = undefined;
      this.tokens.clear();
      return null;
    });
  }
}
