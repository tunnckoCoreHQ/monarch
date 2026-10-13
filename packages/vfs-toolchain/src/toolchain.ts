import path from "node:path/posix";

import { File } from "@bjorn3/browser_wasi_shim";
import type { ExecResult, IFileSystem } from "just-bash";

import type { ConfigEvaluator } from "./js-config.ts";
import { VfsDirectory } from "./wasi-fs.ts";
import { type WasiRun, type WasiTree, utf8 } from "./wasi.ts";

/** Compiled engines. In a Worker these are wasm module imports; in Node, compiled from bytes. */
export interface Engines {
  /** The oxfmt CLI built for wasm32-wasip1. */
  oxfmt?: WebAssembly.Module;
  /** The oxlint CLI built for wasm32-wasip1. */
  oxlint?: WebAssembly.Module;
  /** tsgolint (type-aware rules and type checking) built for wasip1. */
  tsgolint?: WebAssembly.Module;
}

export interface ToolchainOptions {
  engines: Engines;
  /** Evaluates `oxlint.config.ts` / `oxfmt.config.ts` from the VFS. Without it, JS configs are an error. */
  evaluateConfig?: ConfigEvaluator;
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);

/** Files named `names` in `cwd`, its ancestors, and below it: every config a tool run can discover. */
export async function findConfigFiles(
  fs: IFileSystem,
  cwd: string,
  names: readonly string[],
): Promise<string[]> {
  const found: string[] = [];
  const check = async (dir: string): Promise<void> => {
    for (const name of names) {
      const file = path.join(dir, name);
      if ((await fs.exists(file)) && (await fs.stat(file)).isFile) {
        found.push(file);
      }
    }
  };
  for (let dir = cwd; dir !== "/";) {
    dir = path.dirname(dir);
    await check(dir);
  }
  const visit = async (dir: string): Promise<void> => {
    await check(dir);
    for (const name of await fs.readdir(dir)) {
      const child = path.join(dir, name);
      if (!SKIPPED_DIRECTORIES.has(name) && (await fs.lstat(child)).isDirectory) {
        await visit(child);
      }
    }
  };
  if ((await fs.exists(cwd)) && (await fs.stat(cwd)).isDirectory) {
    await visit(cwd);
  }
  return found;
}

/** Evaluate JS configs, reusing results while the file content is unchanged. */
export function createConfigCache(evaluate: ConfigEvaluator | undefined) {
  const cache = new Map<string, { source: string; value: unknown }>();
  return async (fs: IFileSystem, files: readonly string[]): Promise<Record<string, unknown>> => {
    const configs: Record<string, unknown> = {};
    for (const file of files) {
      const source = await fs.readFile(file);
      const cached = cache.get(file);
      if (cached?.source === source) {
        configs[file] = cached.value;
        continue;
      }
      if (!evaluate) {
        throw new Error(`${file}: JavaScript configs need a config evaluator.`);
      }
      const value = await evaluate(file, source);
      cache.set(file, { source, value });
      configs[file] = value;
    }
    return configs;
  };
}

/**
 * Put a file into the WASI tree only (for the tool to read, never written back to the VFS).
 */
export function addInternalFile(tree: WasiTree, absolute: string, content: string): void {
  const parts = absolute.split("/").filter(Boolean);
  let dir = tree.root;
  for (const part of parts.slice(0, -1)) {
    const existing = dir.contents.get(part);
    if (existing instanceof VfsDirectory) {
      dir = existing;
    } else {
      const created = new VfsDirectory(new Map(), tree.root);
      dir.contents.set(part, created);
      dir = created;
    }
  }
  dir.contents.set(parts.at(-1)!, new File(new TextEncoder().encode(content)));
  tree.internal.add(absolute);
}

export function toExecResult(run: WasiRun, extraStderr = ""): ExecResult {
  return {
    stdout: utf8(run.stdout),
    stderr: extraStderr + utf8(run.stderr),
    exitCode: run.exitCode,
  };
}
