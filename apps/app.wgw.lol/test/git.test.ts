import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isService } from "../src/git/protocol";
import type { GitRepo, View } from "../src/git/repo";
import { memoryRepo } from "./memory";

const person = { name: "Tester", email: "t@example.com", time: 1_760_000_000, tz: "+0000" };

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,

    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Tester",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "Tester",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: cwd,
    },
  });
  return stdout.trim();
}

let repo: GitRepo;
let server: Server;
let base: string;
const dir = mkdtempSync(join(tmpdir(), "wgw-git-"));

function serve(view: View) {
  return async (url: URL, method: string, body: Uint8Array) => {
    if (method === "GET" && url.pathname.endsWith("/info/refs")) {
      const service = url.searchParams.get("service");
      if (!isService(service)) {
        return { status: 400, type: "text/plain", body: new Uint8Array() };
      }
      return {
        status: 200,
        type: `application/x-${service}-advertisement`,
        body: repo.advertise(service, view),
      };
    }
    if (url.pathname.endsWith("/git-upload-pack")) {
      return {
        status: 200,
        type: "application/x-git-upload-pack-result",
        body: await repo.uploadPack(body, view),
      };
    }
    const { response } = await repo.receivePack(body);
    return { status: 200, type: "application/x-git-receive-pack-result", body: response };
  };
}

async function respond(req: IncomingMessage, res: ServerResponse, chunks: Buffer[]): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const view: View = url.pathname.startsWith("/public/") ? "public" : "full";
  try {
    const out = await serve(view)(url, req.method ?? "GET", new Uint8Array(Buffer.concat(chunks)));
    res.writeHead(out.status, { "content-type": out.type, "cache-control": "no-cache" });
    res.end(Buffer.from(out.body));
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
}

beforeAll(async () => {
  repo = memoryRepo();
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
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("smart HTTP against real git", () => {
  const src = join(dir, "src");

  it("accepts a push into an empty repository", async () => {
    mkdirSync(src);
    await git(src, "init", "-q", "-b", "main");
    writeFileSync(join(src, "README.md"), "# hello\n");
    mkdirSync(join(src, "lib"));
    writeFileSync(join(src, "lib", "a.txt"), "a\n".repeat(200));
    writeFileSync(join(src, "bin.dat"), Buffer.from([0, 1, 2, 3, 255, 0, 7]));
    await git(src, "add", ".");
    await git(src, "commit", "-q", "-m", "first");
    writeFileSync(join(src, "lib", "a.txt"), `${"a\n".repeat(200)}b\n`);
    await git(src, "commit", "-q", "-am", "second");
    await git(src, "push", "-q", `${base}/r.git`, "main");
    expect(repo.refs("full").map((ref) => ref.name)).toEqual(["refs/heads/main"]);
    expect(repo.log("full", "main").map((commit) => commit.message.trim())).toEqual([
      "second",
      "first",
    ]);
  });

  it("serves a full clone", async () => {
    const out = join(dir, "clone");
    await git(dir, "clone", "-q", `${base}/r.git`, out);
    expect(readFileSync(join(out, "lib", "a.txt"), "utf-8")).toContain("b\n");
    expect(readFileSync(join(out, "bin.dat"))).toEqual(Buffer.from([0, 1, 2, 3, 255, 0, 7]));
    await git(out, "fsck", "--strict");
  });

  it("negotiates an incremental fetch and push", async () => {
    writeFileSync(join(src, "c.txt"), "c\n");
    await git(src, "add", ".");
    await git(src, "commit", "-q", "-m", "third");
    await git(src, "push", "-q", `${base}/r.git`, "main");
    const out = join(dir, "clone");
    await git(out, "pull", "-q", "--ff-only");
    expect(readFileSync(join(out, "c.txt"), "utf-8")).toBe("c\n");
    await git(out, "fsck", "--strict");
  });

  it("serves a shallow clone", async () => {
    const out = join(dir, "shallow");
    await git(dir, "clone", "-q", "--depth", "1", `${base}/r.git`, out);
    expect(await git(out, "rev-list", "--count", "HEAD")).toBe("1");
    expect(existsSync(join(out, "c.txt"))).toBe(true);
  });

  it("deepens and unshallows a shallow clone", async () => {
    const out = join(dir, "shallow");
    await git(out, "fetch", "-q", "--depth", "2");
    expect(await git(out, "rev-list", "--count", "HEAD")).toBe("2");
    // A new commit on top makes the walk pass a commit the client has before its shallow one.
    writeFileSync(join(src, "e.txt"), "e\n");
    await git(src, "add", ".");
    await git(src, "commit", "-q", "-m", "fourth");
    await git(src, "push", "-q", `${base}/r.git`, "main");
    await git(out, "fetch", "-q", "--unshallow");
    expect(await git(out, "rev-list", "--count", "origin/main")).toBe("4");
    await git(out, "fsck", "--strict");
  });

  it("rejects a stale push", async () => {
    const out = join(dir, "stale");
    await git(dir, "clone", "-q", `${base}/r.git`, out);
    await git(out, "reset", "-q", "--hard", "HEAD~1");
    writeFileSync(join(out, "d.txt"), "d\n");
    await git(out, "add", ".");
    await git(out, "commit", "-q", "-m", "diverged");
    await expect(git(out, "push", "-q", `${base}/r.git`, "main")).rejects.toThrow();
  });

  it("hides private paths from the public projection", async () => {
    writeFileSync(join(src, ".gitprivate"), "security/\n*.secret\n");
    mkdirSync(join(src, "security"));
    writeFileSync(join(src, "security", "advisory.md"), "CVE details\n");
    writeFileSync(join(src, "keys.secret"), "hunter2\n");
    writeFileSync(join(src, "public.txt"), "visible\n");
    await git(src, "add", ".");
    await git(src, "commit", "-q", "-m", "embargoed advisory");
    writeFileSync(join(src, "security", "advisory.md"), "CVE details, more\n");
    await git(src, "commit", "-q", "-am", "private only");
    await git(src, "push", "-q", `${base}/r.git`, "main");

    const pub = join(dir, "public");
    await git(dir, "clone", "-q", `${base}/public/r.git`, pub);
    expect(existsSync(join(pub, "public.txt"))).toBe(true);
    expect(existsSync(join(pub, "security"))).toBe(false);
    expect(existsSync(join(pub, "keys.secret"))).toBe(false);
    await git(pub, "fsck", "--strict");
    const messages = (await git(pub, "log", "--format=%s")).split("\n");
    expect(messages).toEqual(["embargoed advisory", "fourth", "third", "second", "first"]);
    // Commits before the rules keep their hashes.
    expect(await git(pub, "rev-parse", "HEAD~1")).toBe(await git(src, "rev-parse", "HEAD~2"));

    const full = join(dir, "full");
    await git(dir, "clone", "-q", `${base}/r.git`, full);
    expect(readFileSync(join(full, "security", "advisory.md"), "utf-8")).toBe(
      "CVE details, more\n",
    );

    // Publishing: removing the rule shows the file from that commit on.
    writeFileSync(join(src, ".gitprivate"), "*.secret\n");
    await git(src, "commit", "-q", "-am", "publish advisory");
    await git(src, "push", "-q", `${base}/r.git`, "main");
    await git(pub, "pull", "-q", "--ff-only");
    expect(readFileSync(join(pub, "security", "advisory.md"), "utf-8")).toBe("CVE details, more\n");
    expect(existsSync(join(pub, "keys.secret"))).toBe(false);
  });

  it("merges branches through the API", async () => {
    const head = repo.resolve("full", "main")!;
    const feature = repo.commitFiles("main", head, "on main", person, [
      { path: "main-only.txt", content: new TextEncoder().encode("m\n") },
    ]);
    repo.updateRef("refs/heads/feature", "0".repeat(40), head);
    repo.commitFiles("feature", head, "on feature", person, [
      { path: "docs/feature.md", content: new TextEncoder().encode("f\n") },
    ]);
    const compare = repo.compare("full", "main", "feature");
    expect(compare.mergeable).toBe(true);
    expect(compare.fastForward).toBe(false);
    expect(compare.files.map((file) => file.path)).toEqual(["docs/feature.md"]);
    const merged = repo.merge("main", "feature", "Merge feature", person);
    expect(repo.readCommit(merged.sha).parents).toEqual([
      feature.sha,
      repo.resolve("full", "feature"),
    ]);
    expect(repo.tree("full", "main", "docs").items.map((item) => item.name)).toEqual([
      "feature.md",
    ]);

    repo.commitFiles("feature", undefined, "conflict a", person, [
      { path: "c.txt", content: new TextEncoder().encode("x\n") },
    ]);
    repo.commitFiles("main", undefined, "conflict b", person, [
      { path: "c.txt", content: new TextEncoder().encode("y\n") },
    ]);
    expect(repo.compare("full", "main", "feature").mergeable).toBe(false);
    expect(() => repo.merge("main", "feature", "Merge", person)).toThrow(/conflict in c.txt/);

    const out = join(dir, "after-merge");
    await git(dir, "clone", "-q", `${base}/r.git`, out);
    await git(out, "fsck", "--strict");
    expect(readFileSync(join(out, "docs", "feature.md"), "utf-8")).toBe("f\n");
  });

  it("starts a new branch from the default branch, so its pull request merges", async () => {
    const main = repo.resolve("full", "main")!;
    const agent = repo.commitFiles("agent/new", undefined, "on a new branch", person, [
      { path: "agent.txt", content: new TextEncoder().encode("a\n") },
    ]);
    expect(repo.readCommit(agent.sha).parents).toEqual([main]);
    // The new branch keeps main's tree, so the pull request shows only the new file.
    const compare = repo.compare("full", "main", "agent/new");
    expect(compare.commits.map((commit) => commit.sha)).toEqual([agent.sha]);
    expect(compare.files.map((file) => file.path)).toEqual(["agent.txt"]);
    expect(compare.files[0].patch).toContain("@@ -0,0 +1,1 @@\n+a\n");
    expect(compare.mergeable).toBe(true);
    expect(repo.merge("main", "agent/new", "Merge agent/new", person).sha).toBe(agent.sha);
    expect(repo.resolve("full", "main")).toBe(agent.sha);

    const feature = repo.resolve("full", "feature")!;
    const from = repo.commitFiles(
      "agent/from",
      undefined,
      "from feature",
      person,
      [{ path: "from.txt", content: new TextEncoder().encode("f\n") }],
      "feature",
    );
    expect(repo.readCommit(from.sha).parents).toEqual([feature]);
    const again = () => repo.commitFiles("agent/from", undefined, "again", person, [], "main");
    expect(again).toThrow(/agent\/from already exists/);
    const unknown = () => repo.commitFiles("agent/x", undefined, "x", person, [], "nosuch");
    expect(unknown).toThrow(/unknown revision nosuch/);

    const out = join(dir, "after-new-branch");
    await git(dir, "clone", "-q", `${base}/r.git`, out);
    await git(out, "fsck", "--strict");
    expect(readFileSync(join(out, "agent.txt"), "utf-8")).toBe("a\n");
  });
});
