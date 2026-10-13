import { File, wasi } from "@bjorn3/browser_wasi_shim";
import { InMemoryFs } from "just-bash/browser";
import { expect, test } from "vitest";

import { loadSnapshot } from "../src/snapshot.ts";
import { Symlink, VfsOpenDirectory } from "../src/wasi-fs.ts";
import { snapshotTree, syncBack } from "../src/wasi.ts";

const STORE = "/repo/node_modules/.pnpm/pkg@1.0.0/node_modules";

async function pnpmLayout(): Promise<InMemoryFs> {
  const fs = new InMemoryFs();
  await loadSnapshot(fs, {
    files: {
      [`${STORE}/pkg/index.d.ts`]: "export declare const x: number;\n",
      [`${STORE}/dep/index.d.ts`]: "export {};\n",
      "/repo/src/a.ts": "export const a = 1;\n",
    },
    links: { "/repo/node_modules/pkg": ".pnpm/pkg@1.0.0/node_modules/pkg" },
  });
  return fs;
}

test("symlinks stay symlinks: lstat sees the link, stat and open follow it", async () => {
  const tree = await snapshotTree(await pnpmLayout());
  const root = new VfsOpenDirectory(tree.root);

  const lstat = root.path_filestat_get(0, "repo/node_modules/pkg");
  expect(lstat.filestat?.filetype).toBe(wasi.FILETYPE_SYMBOLIC_LINK);

  const stat = root.path_filestat_get(1, "repo/node_modules/pkg");
  expect(stat.filestat?.filetype).toBe(wasi.FILETYPE_DIRECTORY);

  expect(root.path_readlink("repo/node_modules/pkg").data).toBe(`${STORE}/pkg`);

  const opened = root.path_open(1, "repo/node_modules/pkg/index.d.ts", 0, 0n, 0n, 0);
  expect(opened.ret).toBe(wasi.ERRNO_SUCCESS);
});

test("`..` after following a link walks the link target's parents, as realpath does", async () => {
  const tree = await snapshotTree(await pnpmLayout());
  const found = tree.root.lookup(["repo", "node_modules", "pkg", "..", "dep", "index.d.ts"], true);
  expect(found.entry).toBeInstanceOf(File);
});

test("a dangling link resolves to ENOENT, a loop to ELOOP", async () => {
  const tree = await snapshotTree(await pnpmLayout());
  tree.root.contents.set("dangling", new Symlink("/missing"));
  tree.root.contents.set("loop", new Symlink("/loop"));
  expect(tree.root.lookup(["dangling"], true).ret).toBe(wasi.ERRNO_NOENT);
  expect(tree.root.lookup(["loop"], true).ret).toBe(wasi.ERRNO_LOOP);
});

test("syncBack writes changed and created files, and skips host-internal ones", async () => {
  const fs = await pnpmLayout();
  const tree = await snapshotTree(fs);
  const src = tree.root.lookup(["repo", "src"], true).entry;
  if (!(src && "contents" in src)) {
    throw new Error("expected /repo/src to be a directory");
  }
  const contents = src.contents as Map<string, File>;
  contents.get("a.ts")!.data = new TextEncoder().encode("export const a = 2;\n");
  contents.set("b.ts", new File(new TextEncoder().encode("export const b = 1;\n")));
  contents.set("internal.json", new File(new Uint8Array()));
  tree.internal.add("/repo/src/internal.json");

  expect((await syncBack(fs, tree)).toSorted()).toEqual(["/repo/src/a.ts", "/repo/src/b.ts"]);
  expect(await fs.readFile("/repo/src/a.ts")).toBe("export const a = 2;\n");
  expect(await fs.exists("/repo/src/internal.json")).toBe(false);
});
