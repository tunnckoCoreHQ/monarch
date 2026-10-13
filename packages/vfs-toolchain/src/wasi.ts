import path from "node:path/posix";

import {
  ConsoleStdout,
  Directory,
  File,
  type Inode,
  OpenFile,
  WASI,
  WASIProcExit,
  wasi,
} from "@bjorn3/browser_wasi_shim";
import type { IFileSystem } from "just-bash";

import { Symlink, VfsDirectory, VfsPreopenDirectory } from "./wasi-fs.ts";

// JSPI (WebAssembly JavaScript Promise Integration), in workerd and in Node with
// `--experimental-wasm-jspi`: a wasm import may return a promise that the module waits on.
interface Jspi {
  // A member every `WebAssembly` has, so TypeScript accepts the namespace as this type.
  Module: typeof WebAssembly.Module;
  Suspending?: new (fn: (...args: number[]) => Promise<number>) => WebAssembly.ImportValue;
  promising?: (fn: WebAssembly.ExportValue) => () => Promise<unknown>;
}
const jspi: Jspi = WebAssembly;

/**
 * A WASI view of the virtual filesystem. The tools are WASI commands built for `wasm32-wasip1`;
 * their only filesystem is this in-memory tree, so every path they discover, read, and write is a
 * path on the VFS. Symlinks stay symlinks, so a pnpm-style `node_modules` resolves the way it does
 * on disk.
 */
export interface WasiTree {
  root: VfsDirectory;
  /** The bytes each file had when the tree was taken, to find what a command changed. */
  originals: Map<string, Uint8Array>;
  /** Files the host added for a tool to read; never written back to the VFS. */
  internal: Set<string>;
}

async function snapshotDirectory(
  fs: IFileSystem,
  dir: string,
  originals: Map<string, Uint8Array>,
): Promise<Map<string, Inode>> {
  const contents = new Map<string, Inode>();
  for (const name of (await fs.readdir(dir)).toSorted()) {
    const absolute = path.join(dir, name);
    const lstat = await fs.lstat(absolute);
    if (lstat.isSymbolicLink) {
      contents.set(name, new Symlink(path.resolve(dir, await fs.readlink(absolute))));
    } else if (lstat.isDirectory) {
      // The shim's Directory constructor links each child directory to its parent.
      contents.set(name, new VfsDirectory(await snapshotDirectory(fs, absolute, originals)));
    } else {
      const data = await fs.readFileBuffer(absolute);
      originals.set(absolute, data);
      contents.set(name, new File(data));
    }
  }
  return contents;
}

function setRoot(directory: VfsDirectory, root: VfsDirectory): void {
  directory.root = root;
  for (const entry of directory.contents.values()) {
    if (entry instanceof VfsDirectory) {
      setRoot(entry, root);
    }
  }
}

/** Copy the virtual filesystem into a WASI directory tree rooted at `/`. */
export async function snapshotTree(fs: IFileSystem): Promise<WasiTree> {
  const originals = new Map<string, Uint8Array>();
  const root = new VfsDirectory(await snapshotDirectory(fs, "/", originals));
  setRoot(root, root);
  return { root, originals, internal: new Set() };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) {
    return true;
  }
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

function collectFiles(dir: Directory, prefix: string, out: Map<string, File>): void {
  for (const [name, entry] of dir.contents) {
    const absolute = path.join(prefix, name);
    if (entry instanceof Directory) {
      collectFiles(entry, absolute, out);
    } else if (entry instanceof File) {
      out.set(absolute, entry);
    }
  }
}

/** Write the files a command created or changed back to the virtual filesystem. */
export async function syncBack(fs: IFileSystem, tree: WasiTree): Promise<string[]> {
  const files = new Map<string, File>();
  collectFiles(tree.root, "/", files);
  const changed: string[] = [];
  for (const [absolute, file] of files) {
    if (tree.internal.has(absolute)) {
      continue;
    }
    const original = tree.originals.get(absolute);
    if (original && sameBytes(original, file.data)) {
      continue;
    }
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, file.data);
    tree.originals.set(absolute, file.data);
    changed.push(absolute);
  }
  return changed;
}

export interface WasiRun {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/** What host functions get: the module's memory and the command's stderr. */
export interface HostContext {
  /** The module's current memory buffer (it changes when memory grows). */
  memory: () => ArrayBuffer;
  writeStderr: (bytes: Uint8Array) => void;
}

export interface WasiCommand {
  module: WebAssembly.Module;
  args: string[];
  env?: Record<string, string>;
  stdin?: Uint8Array;
  tree: WasiTree;
  /** Extra import modules (host functions) besides `wasi_snapshot_preview1`. */
  imports?: (host: HostContext) => WebAssembly.Imports;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * stdout/stderr are pipes, not terminals: the shim reports character devices, which wasi-libc
 * reads as a TTY, and the tools would print colors where a piped native run prints none.
 */
class PipeOutput extends ConsoleStdout {
  // oxlint-disable-next-line class-methods-use-this -- overrides the shim's method.
  fd_fdstat_get(): { ret: number; fdstat: wasi.Fdstat | null } {
    return { ret: wasi.ERRNO_SUCCESS, fdstat: new wasi.Fdstat(wasi.FILETYPE_UNKNOWN, 0) };
  }
}

/** The exports of a WASI command module: its memory and the raw `_start` export. */
function commandExports(instance: WebAssembly.Instance) {
  const { memory, _start: start } = instance.exports;
  if (!(memory instanceof WebAssembly.Memory) || typeof start !== "function") {
    throw new TypeError("not a WASI command: it must export `memory` and `_start`");
  }
  return { memory, start };
}

interface Prepared {
  shim: WASI;
  exports: ReturnType<typeof commandExports>;
  stdout: Uint8Array[];
  stderr: Uint8Array[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function prepare(command: WasiCommand): Prepared {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const env = Object.entries(command.env ?? {}).map(([key, value]) => `${key}=${value}`);
  const shim = new WASI(
    command.args,
    env,
    [
      new OpenFile(new File(command.stdin ?? new Uint8Array())),
      new PipeOutput((bytes) => stdout.push(new Uint8Array(bytes))),
      new PipeOutput((bytes) => stderr.push(new Uint8Array(bytes))),
      new VfsPreopenDirectory("/", command.tree.root),
    ],
    { debug: false },
  );
  const holder: { instance?: WebAssembly.Instance } = {};
  const instance = (): WebAssembly.Instance => {
    if (!holder.instance) {
      throw new Error("the wasm instance is not ready");
    }
    return holder.instance;
  };
  const memory = () => commandExports(instance()).memory.buffer;
  // POSIX readlink truncates to the buffer and reports the bytes written; callers such as Go's
  // os.Readlink retry with a larger buffer. The shim fails with EBADF instead, which breaks
  // realpath for long targets like pnpm store paths.
  const pathReadlink = (
    fd: number,
    pathPtr: number,
    pathLen: number,
    bufPtr: number,
    bufLen: number,
    nreadPtr: number,
  ): number => {
    const opened = shim.fds[fd];
    if (!(opened instanceof VfsPreopenDirectory)) {
      return wasi.ERRNO_BADF;
    }
    const { ret, data } = opened.path_readlink(
      decoder.decode(new Uint8Array(memory(), pathPtr, pathLen)),
    );
    if (data === null) {
      return ret;
    }
    const bytes = encoder.encode(data).subarray(0, bufLen);
    new Uint8Array(memory()).set(bytes, bufPtr);
    new DataView(memory()).setUint32(nreadPtr, bytes.byteLength, true);
    return wasi.ERRNO_SUCCESS;
  };
  holder.instance = new WebAssembly.Instance(command.module, {
    wasi_snapshot_preview1: { ...shim.wasiImport, path_readlink: pathReadlink },
    ...command.imports?.({ memory, writeStderr: (bytes) => stderr.push(bytes) }),
  });
  return { shim, exports: commandExports(holder.instance), stdout, stderr };
}

/** Run a WASI command to completion over `tree`. Synchronous: no threads, no awaits inside. */
export function runWasi(command: WasiCommand): WasiRun {
  const { shim, exports, stdout, stderr } = prepare(command);
  const exitCode =
    shim.start({ exports: { memory: exports.memory, _start: () => exports.start() } }) ?? 0;
  return { exitCode, stdout: concat(stdout), stderr: concat(stderr) };
}

/** Whether host imports can be asynchronous: JSPI (`WebAssembly.Suspending`). */
export const hasJspi =
  typeof jspi.Suspending === "function" && typeof jspi.promising === "function";

/** Wrap an async host function so wasm can call it and suspend until it settles (JSPI). */
export function suspending(fn: (...args: number[]) => Promise<number>): WebAssembly.ImportValue {
  if (!jspi.Suspending) {
    throw new Error("JSPI is unavailable");
  }
  return new jspi.Suspending(fn);
}

/** Run a WASI command whose host imports may suspend (see {@link suspending}). Needs JSPI. */
export async function runWasiAsync(command: WasiCommand): Promise<WasiRun> {
  const { shim, exports, stdout, stderr } = prepare(command);
  // The shim's imports read memory through `inst`, which `start` would set.
  shim.inst = { exports: { memory: exports.memory } };
  let exitCode = 0;
  try {
    if (!jspi.promising) {
      throw new Error("JSPI is unavailable");
    }
    // `promising` needs the export itself, not a JS wrapper around it.
    await jspi.promising(exports.start)();
  } catch (error) {
    if (!(error instanceof WASIProcExit)) {
      throw error;
    }
    exitCode = error.code;
  }
  return { exitCode, stdout: concat(stdout), stderr: concat(stderr) };
}

export function utf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
