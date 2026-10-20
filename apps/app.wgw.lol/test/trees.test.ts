import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { utf8 } from "../src/git/bytes";
import type { GitRepo } from "../src/git/repo";
import { memoryRepo } from "./memory";

const person = { name: "Tester", email: "t@example.com", time: 1_760_000_000, tz: "+0000" };

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), "wgw-trees-"));
let repos = 0;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd },
  });
  return stdout.trim();
}

/** Copies everything `sha` reaches into a new bare repository and runs `git fsck --strict` there. */
async function fsck(repo: GitRepo, sha: string): Promise<string> {
  const bare = join(dir, `repo-${++repos}.git`);
  await git(dir, "init", "-q", "--bare", bare);
  const pack = join(bare, "objects", "pack", "pack-test.pack");
  writeFileSync(pack, await repo.pack(repo.reachable([sha])));
  await git(bare, "index-pack", pack);
  await git(bare, "update-ref", "refs/heads/main", sha);
  await git(bare, "fsck", "--strict");
  return bare;
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("trees the server writes", () => {
  it("keeps the mode of an updated file unless the change names one", async () => {
    const repo = memoryRepo();
    repo.commitFiles("main", undefined, "add", person, [
      { path: "bin/run.sh", content: utf8("echo one\n"), mode: "100755" },
      { path: "latest", content: utf8("bin/run.sh"), mode: "120000" },
      { path: "README.md", content: utf8("# one\n") },
    ]);
    const updated = repo.commitFiles("main", undefined, "update", person, [
      { path: "bin/run.sh", content: utf8("echo two\n") },
      { path: "latest", content: utf8("README.md") },
      { path: "README.md", content: utf8("#!/bin/sh\n"), mode: "100755" },
    ]);
    const bare = await fsck(repo, updated.sha);
    const modes = (await git(bare, "ls-tree", "-r", "--format=%(objectmode) %(path)", "main"))
      .split("\n")
      .toSorted();
    expect(modes).toEqual(["100755 README.md", "100755 bin/run.sh", "120000 latest"]);
  });

  it("drops a directory when each side of a merge deletes a different file in it", async () => {
    const repo = memoryRepo();
    const base = repo.commitFiles("main", undefined, "base", person, [
      { path: "docs/a.md", content: utf8("a\n") },
      { path: "docs/b.md", content: utf8("b\n") },
      { path: "keep.txt", content: utf8("keep\n") },
    ]);
    repo.updateRef("refs/heads/feature", "0".repeat(40), base.sha);
    repo.commitFiles("main", undefined, "drop a", person, [{ path: "docs/a.md", content: null }]);
    repo.commitFiles("feature", undefined, "drop b", person, [
      { path: "docs/b.md", content: null },
    ]);
    const merged = repo.merge("main", "feature", "Merge feature", person);
    const bare = await fsck(repo, merged.sha);
    expect(await git(bare, "ls-tree", "-r", "-t", "--name-only", "main")).toBe("keep.txt");
  });

  it("sorts entries by the UTF-8 bytes of their names", async () => {
    const repo = memoryRepo();
    // U+FF01 sorts before U+1F600 in UTF-8 and after it in UTF-16. A directory sorts as "lib/".
    const commit = repo.commitFiles("main", undefined, "names", person, [
      { path: "\u{FF01}.txt", content: utf8("1\n") },
      { path: "\u{1F600}.txt", content: utf8("2\n") },
      { path: "lib/index.ts", content: utf8("3\n") },
      { path: "lib.ts", content: utf8("4\n") },
      { path: "lib-x.ts", content: utf8("5\n") },
    ]);
    const bare = await fsck(repo, commit.sha);
    const names = await git(bare, "-c", "core.quotePath=false", "ls-tree", "--name-only", "main");
    expect(names.split("\n")).toEqual([
      "lib-x.ts",
      "lib.ts",
      "lib",
      "\u{FF01}.txt",
      "\u{1F600}.txt",
    ]);
  });
});
