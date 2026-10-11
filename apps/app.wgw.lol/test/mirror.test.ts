import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { concat, utf8 } from "../src/git/bytes";
import { Mirror, type Remotes } from "../src/git/mirror";
import { parseCommit, ZERO_SHA } from "../src/git/objects";
import { FLUSH } from "../src/git/pktline";
import { isService } from "../src/git/protocol";
import { fetchPack, lsRemote, sendPack } from "../src/git/remote";
import { GitError, type GitRepo } from "../src/git/repo";
import { planPack } from "../src/git/walk";
import { memoryRepo } from "./memory";

const TOKEN = "art_v1_test";
const MAIN = "refs/heads/main";
const person = { name: "Tester", email: "t@example.com", time: 1_760_000_000, tz: "+0000" };

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    "git",
    ["-c", `http.extraHeader=Authorization: Bearer ${TOKEN}`, ...args],
    {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Tester",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "Tester",
        GIT_COMMITTER_EMAIL: "t@example.com",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        HOME: cwd,
      },
    },
  );
  return stdout.trim();
}

interface Logged {
  path: string;
  body: Uint8Array;
  reply: Uint8Array;
}

/** Every request the fake Artifacts server saw, with the bodies, for checks on negotiation. */
const requests: Logged[] = [];

// A single-byte decoding keeps string offsets equal to byte offsets.
const latin1 = new TextDecoder("latin1");

function contains(bytes: Uint8Array | undefined, needle: string): boolean {
  return bytes !== undefined && latin1.decode(bytes).includes(needle);
}

/** The object count of the pack inside a request or response body. */
function packCount(bytes: Uint8Array | undefined): number | undefined {
  const at = bytes === undefined ? -1 : latin1.decode(bytes).indexOf("PACK");
  if (bytes === undefined || at === -1) {
    return undefined;
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at + 8);
}

function lastRequest(path: string): Logged | undefined {
  return requests.findLast((request) => request.path === path);
}

const token = async () => TOKEN;

let full: GitRepo;
let pub: GitRepo;
let local: GitRepo;
let mirror: Mirror;
let remotes: Remotes;
let server: Server;
let base: string;
const dir = mkdtempSync(join(tmpdir(), "wgw-mirror-"));
const src = join(dir, "src");

async function answer(
  req: IncomingMessage,
  url: URL,
  body: Uint8Array,
): Promise<{ status: number; type: string; body: Uint8Array }> {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return { status: 401, type: "text/plain", body: utf8("missing or wrong token") };
  }
  const match = /^\/(full|public)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
    url.pathname,
  );
  if (match === null) {
    return { status: 404, type: "text/plain", body: utf8("no such repository") };
  }
  const repo = match[1] === "full" ? full : pub;
  if (match[2] === "info/refs") {
    const service = url.searchParams.get("service");
    if (!isService(service)) {
      return { status: 403, type: "text/plain", body: utf8("smart HTTP only") };
    }
    return {
      status: 200,
      type: `application/x-${service}-advertisement`,
      body: repo.advertise(service, "full"),
    };
  }
  if (match[2] === "git-upload-pack") {
    return {
      status: 200,
      type: "application/x-git-upload-pack-result",
      // Real Artifacts ends a result that carries a pack with a flush packet; mirror that for the
      // mirror client, whose requests always end in `done`.
      body: String(req.headers["user-agent"]).includes("(wgw)")
        ? concat([await repo.uploadPack(body, "full"), FLUSH])
        : await repo.uploadPack(body, "full"),
    };
  }
  const { response } = await repo.receivePack(body);
  return { status: 200, type: "application/x-git-receive-pack-result", body: response };
}

async function respond(req: IncomingMessage, res: ServerResponse, chunks: Buffer[]): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const body = new Uint8Array(Buffer.concat(chunks));
  try {
    const out = await answer(req, url, body);
    requests.push({ path: url.pathname, body, reply: out.body });
    res.writeHead(out.status, { "content-type": out.type, "cache-control": "no-cache" });
    res.end(Buffer.from(out.body));
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
}

beforeAll(async () => {
  full = memoryRepo();
  pub = memoryRepo();
  local = memoryRepo();
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      respond(req, res, chunks).catch((error: unknown) =>
        res.destroy(error instanceof Error ? error : undefined),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  remotes = {
    full: { url: `${base}/full.git`, token },
    public: { url: `${base}/public.git`, token },
  };
  mirror = new Mirror(local, local.storage, remotes);
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the git smart HTTP client", () => {
  it("needs the bearer token", async () => {
    const wrong = { url: `${base}/full.git`, token: async () => "art_v1_wrong" };
    const error = await lsRemote(wrong, "git-upload-pack").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({ status: 502, message: expect.stringContaining("401") });
    expect(await lsRemote(remotes.full, "git-receive-pack")).toMatchObject({ refs: [] });
  });

  it("sends no request for an empty fetch", async () => {
    requests.length = 0;
    expect(await fetchPack(remotes.full, [], ["a".repeat(40)])).toEqual(new Uint8Array());
    expect(requests).toEqual([]);
  });
});

describe("Mirror against real git", () => {
  it("syncs pushes from the full remote, then fetches incrementally", async () => {
    mkdirSync(src);
    await git(src, "init", "-q", "-b", "main");
    writeFileSync(join(src, "README.md"), "# hello\n");
    mkdirSync(join(src, "lib"));
    writeFileSync(join(src, "lib", "a.txt"), "a\n".repeat(200));
    await git(src, "add", ".");
    await git(src, "commit", "-q", "-m", "first");
    writeFileSync(join(src, "lib", "a.txt"), `${"a\n".repeat(200)}b\n`);
    await git(src, "commit", "-q", "-am", "second");
    await git(src, "push", "-q", `${base}/full.git`, "main");
    const second = await git(src, "rev-parse", "HEAD");

    // A second call during a run gets its own run after it; callers during that wait share it.
    const first = mirror.refresh();
    const queued = mirror.refresh();
    expect(queued).not.toBe(first);
    expect(mirror.refresh()).toBe(queued);
    expect(await first).toEqual([{ ref: MAIN, old: ZERO_SHA, new: second }]);
    expect(await queued).toEqual([]);
    // A refresh alone never publishes; sync does.
    expect(pub.storage.refs.list()).toEqual([]);
    expect(await mirror.sync()).toEqual([]);
    expect(local.refs("full")).toEqual(full.refs("full"));
    expect(local.storage.refs.head()).toBe(MAIN);
    expect(pub.refs("full")).toEqual(local.refs("public"));
    expect(pub.refs("full")).toEqual(full.refs("full"));

    writeFileSync(join(src, "c.txt"), "c\n");
    await git(src, "add", ".");
    await git(src, "commit", "-q", "-m", "third");
    await git(src, "push", "-q", `${base}/full.git`, "main");
    const third = await git(src, "rev-parse", "HEAD");
    requests.length = 0;
    expect(await mirror.sync()).toEqual([{ ref: MAIN, old: second, new: third }]);
    const fetched = lastRequest("/full.git/git-upload-pack");
    expect(contains(fetched?.body, `have ${second}`)).toBe(true);
    // Only the new commit, its root tree, and c.txt travel.
    expect(packCount(fetched?.reply)).toBe(3);
    expect(local.refs("full")).toEqual(full.refs("full"));
    expect(pub.refs("full")).toEqual(full.refs("full"));

    // Nothing new: no fetch and no push.
    requests.length = 0;
    expect(await mirror.sync()).toEqual([]);
    expect(requests.map((request) => request.path)).toEqual([
      "/full.git/info/refs",
      "/public.git/info/refs",
    ]);

    const clone = join(dir, "first-public");
    await git(dir, "clone", "-q", `${base}/public.git`, clone);
    expect(await git(clone, "rev-parse", "HEAD")).toBe(third);
    await git(clone, "fsck", "--strict");
  });

  it("publishes the projection without private paths", async () => {
    const third = await git(src, "rev-parse", "HEAD");
    writeFileSync(join(src, ".gitprivate"), "security/\n*.pem\n");
    mkdirSync(join(src, "security"));
    writeFileSync(join(src, "security", "advisory.md"), "CVE details\n");
    writeFileSync(join(src, "deploy.pem"), "-----BEGIN PRIVATE KEY-----\n");
    writeFileSync(join(src, "public.txt"), "visible\n");
    await git(src, "add", ".");
    await git(src, "commit", "-q", "-m", "embargoed advisory");
    const draft = await git(src, "rev-parse", "HEAD:security/advisory.md");
    const key = await git(src, "rev-parse", "HEAD:deploy.pem");
    writeFileSync(join(src, "security", "advisory.md"), "CVE details, more\n");
    await git(src, "commit", "-q", "-am", "private only");
    await git(src, "push", "-q", `${base}/full.git`, "main");
    await mirror.sync();
    expect(local.resolve("full", "main")).toBe(await git(src, "rev-parse", "HEAD"));

    const clone = join(dir, "public");
    await git(dir, "clone", "-q", `${base}/public.git`, clone);
    expect(readFileSync(join(clone, "public.txt"), "utf-8")).toBe("visible\n");
    expect(existsSync(join(clone, ".gitprivate"))).toBe(true);
    expect(existsSync(join(clone, "security"))).toBe(false);
    expect(existsSync(join(clone, "deploy.pem"))).toBe(false);
    await git(clone, "fsck", "--strict");
    expect((await git(clone, "log", "--format=%s")).split("\n")).toEqual([
      "embargoed advisory",
      "third",
      "second",
      "first",
    ]);
    // Commits from before the rules keep their hashes.
    expect(await git(clone, "rev-parse", "HEAD~1")).toBe(third);
    expect(pub.objects.has(draft)).toBe(false);
    expect(pub.objects.has(key)).toBe(false);
    const embargoed = await git(clone, "rev-parse", "HEAD");

    // Removing the rule publishes the advisory from that commit on.
    writeFileSync(join(src, ".gitprivate"), "*.pem\n");
    await git(src, "commit", "-q", "-am", "publish advisory");
    await git(src, "push", "-q", `${base}/full.git`, "main");
    await mirror.sync();
    await git(clone, "pull", "-q", "--ff-only");
    expect(readFileSync(join(clone, "security", "advisory.md"), "utf-8")).toBe(
      "CVE details, more\n",
    );
    expect(existsSync(join(clone, "deploy.pem"))).toBe(false);
    expect(await git(clone, "rev-parse", "HEAD~1")).toBe(embargoed);
    await git(clone, "fsck", "--strict");
    expect(pub.objects.has(draft)).toBe(false);
    expect(pub.objects.has(key)).toBe(false);
  });

  it("propagates a branch deletion to the mirror and the public remote", async () => {
    await git(src, "checkout", "-q", "-b", "feature");
    writeFileSync(join(src, "feature.txt"), "f\n");
    await git(src, "add", ".");
    await git(src, "commit", "-q", "-m", "feature work");
    await git(src, "push", "-q", `${base}/full.git`, "feature");
    await git(src, "checkout", "-q", "main");
    const feature = await git(src, "rev-parse", "feature");
    const ref = "refs/heads/feature";

    full.storage.refs.setHead(ref);
    expect(await mirror.sync()).toEqual([{ ref, old: ZERO_SHA, new: feature }]);
    expect(local.storage.refs.head()).toBe(ref);
    const projected = local.refs("public").find((item) => item.name === ref)?.sha;
    expect(projected).toBeDefined();
    expect(pub.storage.refs.get(ref)).toBe(projected);

    full.storage.refs.setHead(MAIN);
    await git(src, "push", "-q", `${base}/full.git`, "--delete", "feature");
    expect(await mirror.sync()).toEqual([{ ref, old: feature, new: ZERO_SHA }]);
    expect(local.storage.refs.get(ref)).toBeUndefined();
    expect(local.storage.refs.head()).toBe(MAIN);
    expect(pub.refs("full").map((item) => item.name)).toEqual([MAIN]);
    // A delete-only push carries no pack.
    expect(packCount(lastRequest("/public.git/git-receive-pack")?.body)).toBeUndefined();
  });

  it("pushes a server-side commit to the full remote", async () => {
    const before = local.resolve("full", "main")!;
    const { sha, update } = local.commitFiles("main", before, "api commit", person, [
      { path: "api/notes.txt", content: utf8("from the api\n") },
    ]);
    requests.length = 0;
    await mirror.pushLocal(update);
    // pushLocal leaves publishing to the caller.
    await mirror.publish();
    expect(full.storage.refs.get(MAIN)).toBe(sha);
    // The commit, the root tree, api/, and the blob.
    expect(packCount(lastRequest("/full.git/git-receive-pack")?.body)).toBe(4);

    await git(src, "fetch", "-q", `${base}/full.git`, "main");
    expect(await git(src, "rev-parse", "FETCH_HEAD")).toBe(sha);
    await git(src, "merge", "-q", "--ff-only", "FETCH_HEAD");
    expect(readFileSync(join(src, "api", "notes.txt"), "utf-8")).toBe("from the api\n");
    await git(src, "fsck", "--strict");

    const projected = local.refs("public").find((ref) => ref.name === MAIN)?.sha;
    expect(projected).toBeDefined();
    expect(pub.storage.refs.get(MAIN)).toBe(projected);
    expect(pub.readCommit(projected!).message).toBe("api commit\n");
  });

  it("rejects a stale server-side write and restores the local ref", async () => {
    writeFileSync(join(src, "race.txt"), "pushed first\n");
    await git(src, "add", ".");
    await git(src, "commit", "-q", "-m", "racing push");
    await git(src, "push", "-q", `${base}/full.git`, "main");
    const racing = await git(src, "rev-parse", "HEAD");

    const old = local.storage.refs.get(MAIN)!;
    const stale = local.commitFiles("main", old, "stale api commit", person, [
      { path: "stale.txt", content: utf8("too late\n") },
    ]);
    expect(local.storage.refs.get(MAIN)).toBe(stale.sha);
    const error = await mirror.pushLocal(stale.update).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({ status: 409 });
    expect(local.storage.refs.get(MAIN)).toBe(old);
    expect(full.storage.refs.get(MAIN)).toBe(racing);

    // The remote's own compare-and-swap rejects the same push, and sendPack reports its reason.
    const pack = await local.pack(planPack(local.objects, [stale.sha], [old]).objects);
    await expect(sendPack(remotes.full, [stale.update], pack)).rejects.toMatchObject({
      status: 409,
      message: "refs/heads/main: fetch first",
    });
    expect(full.storage.refs.get(MAIN)).toBe(racing);

    expect(await mirror.sync()).toEqual([{ ref: MAIN, old, new: racing }]);
  });

  it("pushes a merge commit with two parents", async () => {
    const main = local.resolve("full", "main")!;
    const topicRef = "refs/heads/topic";
    requests.length = 0;
    await mirror.pushLocal(local.updateRef(topicRef, ZERO_SHA, main));
    expect(full.storage.refs.get(topicRef)).toBe(main);
    // A new branch at a commit the remote has needs an empty pack, not the whole history.
    expect(packCount(lastRequest("/full.git/git-receive-pack")?.body)).toBe(0);

    const topic = local.commitFiles("topic", main, "on topic", person, [
      { path: "docs/topic.md", content: utf8("t\n") },
    ]);
    await mirror.pushLocal(topic.update);
    const ours = local.commitFiles("main", main, "on main", person, [
      { path: "main-only.txt", content: utf8("m\n") },
    ]);
    await mirror.pushLocal(ours.update);
    const merged = local.merge("main", "topic", "Merge topic", {
      ...person,
      time: person.time + 60,
    });
    await mirror.pushLocal(merged.update);
    await mirror.publish();
    expect(full.storage.refs.get(MAIN)).toBe(merged.sha);

    await git(src, "fetch", "-q", `${base}/full.git`, "main");
    expect((await git(src, "rev-list", "--parents", "-n", "1", "FETCH_HEAD")).split(" ")).toEqual([
      merged.sha,
      ours.sha,
      topic.sha,
    ]);
    const clone = join(dir, "after-merge");
    await git(dir, "clone", "-q", `${base}/full.git`, clone);
    await git(clone, "fsck", "--strict");
    expect(readFileSync(join(clone, "docs", "topic.md"), "utf-8")).toBe("t\n");
    expect(readFileSync(join(clone, "main-only.txt"), "utf-8")).toBe("m\n");

    const projected = local.refs("public").find((ref) => ref.name === MAIN)?.sha;
    expect(pub.storage.refs.get(MAIN)).toBe(projected);
    expect(pub.readCommit(projected!).parents).toHaveLength(2);
    expect(pub.refs("full").map((ref) => ref.name)).toEqual([MAIN, topicRef]);
  });

  it("leaves a ref to the push in flight when a sync runs meanwhile", async () => {
    const held = Promise.withResolvers<undefined>();
    const gate = Promise.withResolvers<undefined>();
    // Holds the push to the full remote until the sync below has run. The cast drops the
    // `preconnect` member that `typeof fetch` carries in the Bun types.
    const gated = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/full.git/git-receive-pack")) {
        held.resolve(undefined);
        await gate.promise;
      }
      return fetch(input, init);
    }) as typeof fetch;
    const racer = new Mirror(local, local.storage, remotes, gated);
    const before = local.storage.refs.get(MAIN)!;
    const published = pub.storage.refs.get(MAIN);
    const write = local.commitFiles("main", before, "in flight", person, [
      { path: "flight.txt", content: utf8("in flight\n") },
    ]);
    const pushed = racer.pushLocal(write.update);
    await held.promise;
    // The remote still has the old commit, but the sync must not undo the write.
    expect(await racer.sync()).toEqual([]);
    expect(local.storage.refs.get(MAIN)).toBe(write.sha);
    expect(pub.storage.refs.get(MAIN)).toBe(published);
    gate.resolve(undefined);
    await pushed;
    expect(full.storage.refs.get(MAIN)).toBe(write.sha);
    // The caller publishes after the push, as the Repo Durable Object does.
    await racer.publish();
    expect(pub.storage.refs.get(MAIN)).toBe(
      local.refs("public").find((ref) => ref.name === MAIN)?.sha,
    );
    expect(pub.storage.refs.get(MAIN)).not.toBe(published);
  });

  it("runs again for a sync requested while another one has already read the refs", async () => {
    const held = Promise.withResolvers<undefined>();
    const gate = Promise.withResolvers<undefined>();
    let first = true;
    // Holds the first run right after it read the full remote's refs.
    const gated = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (first && String(input).includes("/full.git/info/refs")) {
        first = false;
        held.resolve(undefined);
        await gate.promise;
      }
      return response;
    }) as typeof fetch;
    const racer = new Mirror(local, local.storage, remotes, gated);
    const running = racer.sync();
    await held.promise;
    // A push lands after the first run read the refs; the caller who asks now must see it.
    const upstream = full.storage.refs.get(MAIN)!;
    const late = full.commitFiles("main", upstream, "late push", person, [
      { path: "late.txt", content: utf8("late\n") },
    ]);
    const asked = racer.sync();
    gate.resolve(undefined);
    await running;
    await asked;
    expect(local.storage.refs.get(MAIN)).toBe(late.sha);
    expect(local.readCommit(pub.storage.refs.get(MAIN)!).message).toBe("late push\n");
  });

  it("fetches a long history in bounded rounds", async () => {
    // A fresh mirror with two commits per round has to deepen several times.
    const fresh = memoryRepo();
    const bounded = new Mirror(fresh, fresh.storage, remotes, undefined, { fetchDepth: 2 });
    const before = requests.length;
    await bounded.refresh();
    const fetches = requests
      .slice(before)
      .filter((logged) => logged.path === "/full.git/git-upload-pack");
    expect(fetches.length).toBeGreaterThan(2);
    expect(fetches.every((logged) => contains(logged.body, "deepen 2"))).toBe(true);
    // Later rounds tell the remote where this mirror's history stops.
    expect(fetches.slice(1).every((logged) => contains(logged.body, "shallow "))).toBe(true);
    expect(fresh.storage.refs.list()).toEqual(full.storage.refs.list());
    const tip = full.storage.refs.get(MAIN)!;
    expect(fresh.log("full", tip, 1000).map((commit) => commit.sha)).toEqual(
      full.log("full", tip, 1000).map((commit) => commit.sha),
    );
    // Every object reachable from the tips arrived.
    const tips = full.storage.refs.list().map((ref) => ref.sha);
    expect(planPack(fresh.storage.objects, tips, []).objects.toSorted()).toEqual(
      planPack(full.storage.objects, tips, []).objects.toSorted(),
    );
  });

  it("resumes a fetch that stopped between rounds before it moves any ref", async () => {
    const fresh = memoryRepo();
    let rounds = 0;
    // The second fetch round fails, as a dropped connection would.
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/full.git/git-upload-pack") && ++rounds === 2) {
        throw new TypeError("network connection lost");
      }
      return fetch(input, init);
    }) as typeof fetch;
    const broken = new Mirror(fresh, fresh.storage, remotes, flaky, { fetchDepth: 2 });
    await expect(broken.refresh()).rejects.toThrow();
    // The tip arrived, but its history did not, so no ref points at it yet.
    expect(fresh.storage.refs.list()).toEqual([]);
    expect(fresh.storage.shallow.list().length).toBeGreaterThan(0);

    const resumed = new Mirror(fresh, fresh.storage, remotes, undefined, { fetchDepth: 2 });
    await resumed.refresh();
    expect(fresh.storage.shallow.list()).toEqual([]);
    expect(fresh.storage.refs.list()).toEqual(full.storage.refs.list());
    const tips = full.storage.refs.list().map((ref) => ref.sha);
    expect(planPack(fresh.storage.objects, tips, []).objects.toSorted()).toEqual(
      planPack(full.storage.objects, tips, []).objects.toSorted(),
    );
  });

  it("keeps an abandoned fetch recorded without letting it block refreshes", async () => {
    const fresh = memoryRepo();
    // A commit from a fetch that stopped: its parent never arrived, and no remote branch reaches it.
    const lost = "1".repeat(40);
    const orphan = fresh.objects.write(
      "commit",
      utf8(
        `tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nparent ${lost}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nabandoned\n`,
      ),
    );
    fresh.storage.shallow.add(orphan);
    const mirrored = new Mirror(fresh, fresh.storage, remotes);
    const before = requests.length;
    await mirrored.refresh();
    expect(fresh.storage.refs.list()).toEqual(full.storage.refs.list());
    // The refresh never asked for the lost parent, and the record of the abandoned fetch stays.
    const asked = requests
      .slice(before)
      .filter((logged) => logged.path === "/full.git/git-upload-pack");
    expect(asked.some((logged) => contains(logged.body, lost))).toBe(false);
    expect(fresh.storage.shallow.list()).toEqual([orphan]);
  });

  it("resumes a stopped fetch after the remote branch moved on", async () => {
    const fresh = memoryRepo();
    let rounds = 0;
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/full.git/git-upload-pack") && ++rounds === 2) {
        throw new TypeError("network connection lost");
      }
      return fetch(input, init);
    }) as typeof fetch;
    await expect(
      new Mirror(fresh, fresh.storage, remotes, flaky, { fetchDepth: 2 }).refresh(),
    ).rejects.toThrow();
    expect(fresh.storage.shallow.list().length).toBeGreaterThan(0);

    // Someone pushes before the next sync, so the stored part of the history is now one commit
    // below the remote tip, and the recorded commits are not reachable until that commit arrives.
    const tip = full.storage.refs.get(MAIN)!;
    const { tree } = parseCommit(full.objects.read(tip)!.content);
    const next = full.objects.write(
      "commit",
      utf8(
        `tree ${tree}\nparent ${tip}\nauthor A <a@x> 2 +0000\ncommitter A <a@x> 2 +0000\n\nnext\n`,
      ),
    );
    full.storage.refs.set(MAIN, next);
    try {
      await new Mirror(fresh, fresh.storage, remotes, undefined, { fetchDepth: 2 }).refresh();
      expect(fresh.storage.shallow.list()).toEqual([]);
      expect(fresh.storage.refs.get(MAIN)).toBe(next);
      const tips = full.storage.refs.list().map((ref) => ref.sha);
      expect(planPack(fresh.storage.objects, tips, []).objects.toSorted()).toEqual(
        planPack(full.storage.objects, tips, []).objects.toSorted(),
      );
    } finally {
      full.storage.refs.set(MAIN, tip);
    }
  });
});
