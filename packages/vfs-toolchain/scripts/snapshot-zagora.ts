// Development helper: copy packages/zagora, the repository configs it depends on, and the
// node_modules packages that linting and type checking read, into a VFS snapshot (JSON). The
// toolchain itself never reads the disk; this script is how a real package gets into the VFS.
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { Snapshot } from "../src/snapshot.ts";

const REPO = path.resolve(import.meta.dirname, "../../..");
// The VFS mirrors the repository under this root.
const VFS_ROOT = "/repo";
const OUT = path.resolve(import.meta.dirname, "../fixtures/zagora.snapshot.json");

const files: Snapshot["files"] = {};
const links: Snapshot["links"] = {};
const visited = new Set<string>();

const toVfs = (real: string) =>
  path.posix.join(VFS_ROOT, path.relative(REPO, real).split(path.sep).join("/"));

/** Source text: everything outside node_modules, and type and manifest files inside it. */
function keepFile(real: string): boolean {
  if (real.includes(`${path.sep}node_modules${path.sep}`)) {
    return /\.d\.[cm]?ts$|[/\\]package\.json$/.test(real);
  }
  return true;
}

function keepDirectory(real: string): boolean {
  if (
    /[/\\](?:\.bin|\.git|\.turbo|\.cache)$/.test(real) ||
    /@typescript[/\\]typescript-/.test(real)
  ) {
    return false;
  }
  // Build output and coverage of the project itself; packages in node_modules keep their dist.
  return (
    real.includes(`${path.sep}node_modules${path.sep}`) || !/[/\\](?:dist|coverage)$/.test(real)
  );
}

function copy(real: string): void {
  if (visited.has(real)) {
    return;
  }
  visited.add(real);
  const stat = lstatSync(real);
  if (stat.isSymbolicLink()) {
    const target = realpathSync(real);
    if (!target.startsWith(REPO)) {
      return;
    }
    links[toVfs(real)] = readlinkSync(real);
    copy(target);
    // A pnpm package's dependencies are its siblings in `.pnpm/<id>/node_modules`.
    const store = /^(.*[/\\]node_modules[/\\]\.pnpm[/\\][^/\\]+[/\\]node_modules)[/\\]/.exec(
      target,
    );
    if (store) {
      copy(store[1]);
    }
    return;
  }
  if (stat.isDirectory()) {
    if (!keepDirectory(real)) {
      return;
    }
    for (const name of readdirSync(real)) {
      copy(path.join(real, name));
    }
    return;
  }
  if (stat.isFile() && keepFile(real)) {
    files[toVfs(real)] = readFileSync(real, "utf-8");
  }
}

// Repository configs `ultracite fix` reads from the root, then the package itself.
for (const name of [
  "package.json",
  "tsconfig.json",
  "oxlint.config.ts",
  "oxfmt.config.ts",
  ".gitignore",
  ".editorconfig",
]) {
  const real = path.join(REPO, name);
  try {
    statSync(real);
    copy(real);
  } catch {
    // Not every repository has every config.
  }
}
copy(path.join(REPO, "packages/zagora"));
// Packages named in the root tsconfig `types`, which type checking loads.
for (const name of ["@types", "@cloudflare/workers-types", "vitest", "bun-types"]) {
  try {
    copy(path.join(REPO, "node_modules", name));
  } catch {
    // Optional.
  }
}

// The VFS copy skips the one test that needs the network.
const mainTest = `${VFS_ROOT}/packages/zagora/test/main.test.ts`;
files[mainTest] = files[mainTest].replace(
  'test("handle optional/default values in object schemas"',
  'test.skip("handle optional/default values in object schemas"',
);
// It also leaves out the test of the built package: the VFS has no build step, so `../dist` does
// not exist there (in the repository, turbo builds before `check`).
delete files[`${VFS_ROOT}/packages/zagora/test/auto-callable-dist.test.ts`];

const snapshot: Snapshot = { files, links };
writeFileSync(OUT, JSON.stringify(snapshot));
const bytes = Object.values(files).reduce((total, text) => total + text.length, 0);
console.log(
  `${Object.keys(files).length} files, ${Object.keys(links).length} links, ${(bytes / 1e6).toFixed(1)} MB -> ${path.relative(process.cwd(), OUT)}`,
);
