import { defineCommand } from "just-bash/browser";

import {
  addInternalFile,
  createConfigCache,
  findConfigFiles,
  toExecResult,
  type ToolchainOptions,
} from "./toolchain.ts";
import { type HostContext, runWasi, snapshotTree, syncBack, type WasiTree } from "./wasi.ts";

// The oxlint CLI reads evaluated `oxlint.config.ts` files from here (see the wasip1 build).
const JS_CONFIGS_PATH = "/.oxlint/js-configs.json";
const CONFIG_NAMES = ["oxlint.config.ts", "oxlint.config.mts"];

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * The `oxlint_host` imports of the oxlint wasm build. Natively oxlint spawns `tsgolint headless`
 * for type-aware rules and type checking; here `tsgolint_run` runs tsgolint.wasm over the same
 * tree, so it reads the files oxlint has just fixed, as the native child process does from disk.
 */
function oxlintHost(tsgolint: WebAssembly.Module | undefined, tree: WasiTree) {
  return ({ memory, writeStderr }: HostContext): WebAssembly.Imports => {
    let pending: Uint8Array = new Uint8Array();
    return {
      oxlint_host: {
        tsgolint_run(
          cwdPtr: number,
          cwdLen: number,
          argsPtr: number,
          argsLen: number,
          stdinPtr: number,
          stdinLen: number,
          stdoutLenPtr: number,
        ): number {
          if (!tsgolint) {
            writeStderr(
              encoder.encode(
                "oxlint: the tsgolint engine is not loaded, so type-aware linting is unavailable\n",
              ),
            );
            return -1;
          }
          const bytes = new Uint8Array(memory());
          const cwd = decoder.decode(bytes.subarray(cwdPtr, cwdPtr + cwdLen));
          // Arguments arrive NUL-separated.
          const args = decoder
            .decode(bytes.subarray(argsPtr, argsPtr + argsLen))
            .split("\0")
            .filter(Boolean);
          const run = runWasi({
            module: tsgolint,
            args: ["tsgolint", ...args],
            env: { PWD: cwd },
            stdin: bytes.slice(stdinPtr, stdinPtr + stdinLen),
            tree,
          });
          // A native child process inherits oxlint's stderr.
          if (run.stderr.byteLength > 0) {
            writeStderr(run.stderr);
          }
          pending = run.stdout;
          new DataView(memory()).setUint32(stdoutLenPtr, pending.byteLength, true);
          return run.exitCode;
        },
        tsgolint_take_stdout(outPtr: number): void {
          new Uint8Array(memory()).set(pending, outPtr);
          pending = new Uint8Array();
        },
      },
    };
  };
}

/**
 * `oxlint`: the real oxlint CLI (wasm32-wasip1) over the virtual filesystem. It discovers configs,
 * nested configs, and ignore files itself, builds the module graph for import rules, runs
 * tsgolint for `--type-aware` / `--type-check`, and writes `--fix` results back to the VFS.
 * JS plugins (`jsPlugins`) are skipped with a warning.
 */
export function oxlintCommand(options: ToolchainOptions) {
  const evaluateConfigs = createConfigCache(options.evaluateConfig);
  return defineCommand("oxlint", async (args, ctx) => {
    const module = options.engines.oxlint;
    if (!module) {
      return { stdout: "", stderr: "oxlint: the oxlint engine is not loaded\n", exitCode: 127 };
    }
    let configs: Record<string, unknown>;
    try {
      configs = await evaluateConfigs(ctx.fs, await findConfigFiles(ctx.fs, ctx.cwd, CONFIG_NAMES));
    } catch (error) {
      return { stdout: "", stderr: `oxlint: ${String(error)}\n`, exitCode: 1 };
    }
    const tree = await snapshotTree(ctx.fs);
    addInternalFile(tree, JS_CONFIGS_PATH, JSON.stringify(configs));
    const run = runWasi({
      module,
      args: ["oxlint", ...args],
      env: { PWD: ctx.cwd, OXLINT_JS_CONFIGS: JS_CONFIGS_PATH },
      tree,
      imports: oxlintHost(options.engines.tsgolint, tree),
    });
    await syncBack(ctx.fs, tree);
    return toExecResult(run);
  });
}
