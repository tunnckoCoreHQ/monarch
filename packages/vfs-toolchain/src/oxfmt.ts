import { defineCommand } from "just-bash/browser";
import type { Options } from "prettier";
import * as acorn from "prettier/plugins/acorn";
import * as angular from "prettier/plugins/angular";
import * as babel from "prettier/plugins/babel";
import * as estree from "prettier/plugins/estree";
import * as flow from "prettier/plugins/flow";
import * as glimmer from "prettier/plugins/glimmer";
import * as graphql from "prettier/plugins/graphql";
import * as html from "prettier/plugins/html";
import * as markdown from "prettier/plugins/markdown";
import * as meriyah from "prettier/plugins/meriyah";
import * as postcss from "prettier/plugins/postcss";
import * as typescript from "prettier/plugins/typescript";
import * as yaml from "prettier/plugins/yaml";
import { format as prettierFormat } from "prettier/standalone";

import {
  addInternalFile,
  createConfigCache,
  findConfigFiles,
  toExecResult,
  type ToolchainOptions,
} from "./toolchain.ts";
import {
  hasJspi,
  type HostContext,
  runWasi,
  runWasiAsync,
  snapshotTree,
  suspending,
  syncBack,
} from "./wasi.ts";

// The oxfmt CLI reads evaluated `oxfmt.config.ts` files from here (see the wasip1 build).
const JS_CONFIGS_PATH = "/.oxfmt/js-configs.json";
const CONFIG_NAMES = ["oxfmt.config.ts", "oxfmt.config.mts"];
const PRETTIER_PLUGINS = [
  acorn,
  angular,
  babel,
  estree,
  flow,
  glimmer,
  graphql,
  html,
  markdown,
  meriyah,
  postcss,
  typescript,
  yaml,
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The `oxfmt_host` imports of the oxfmt wasm build. Languages oxfmt formats with Prettier
 * (markdown, HTML, …) call `prettier_format`, which is asynchronous here, so it needs JSPI.
 * Without JSPI those files are skipped, as the pure-Rust oxfmt CLI does.
 */
function oxfmtHost(prettier: boolean) {
  let response = new Uint8Array();
  const respond = (status: number, body: string): number => {
    response = encoder.encode(body);
    return status;
  };
  return (host: HostContext): WebAssembly.Imports => {
    const memory = () => new Uint8Array(host.memory());
    const read = (ptr: number, len: number) => decoder.decode(memory().subarray(ptr, ptr + len));
    const formatWithPrettier = async (ptr: number, len: number): Promise<number> => {
      // SAFETY: the request is the JSON object the oxfmt host interface defines.
      const request = JSON.parse(read(ptr, len)) as { options: Options; code: string };
      try {
        const code = await prettierFormat(request.code, {
          ...request.options,
          plugins: PRETTIER_PLUGINS,
        });
        return respond(0, code);
      } catch (error) {
        return respond(1, String(error));
      }
    };
    return {
      oxfmt_host: {
        // Bit 1: Prettier. Bit 2 (Tailwind class sorting) is not offered.
        capabilities: () => (prettier ? 1 : 0),
        prettier_format: prettier
          ? suspending(formatWithPrettier)
          : () => respond(1, "Prettier is unavailable"),
        tailwind_sort: () => respond(1, "Tailwind sorting is unavailable"),
        response_len: () => response.byteLength,
        response_read: (dst: number) => memory().set(response, dst),
      },
    };
  };
}

/**
 * `oxfmt`: the real oxfmt CLI (wasm32-wasip1) over the virtual filesystem. It discovers configs,
 * `.editorconfig`, and ignore files itself; formatted files are written back to the VFS.
 */
export function oxfmtCommand(options: ToolchainOptions) {
  const evaluateConfigs = createConfigCache(options.evaluateConfig);
  return defineCommand("oxfmt", async (args, ctx) => {
    const module = options.engines.oxfmt;
    if (!module) {
      return { stdout: "", stderr: "oxfmt: the oxfmt engine is not loaded\n", exitCode: 127 };
    }
    let configs: Record<string, unknown>;
    try {
      configs = await evaluateConfigs(ctx.fs, await findConfigFiles(ctx.fs, ctx.cwd, CONFIG_NAMES));
    } catch (error) {
      return { stdout: "", stderr: `oxfmt: ${String(error)}\n`, exitCode: 2 };
    }
    const tree = await snapshotTree(ctx.fs);
    addInternalFile(tree, JS_CONFIGS_PATH, JSON.stringify(configs));
    const command = {
      module,
      args: ["oxfmt", ...args],
      env: { PWD: ctx.cwd, OXFMT_JS_CONFIGS: JS_CONFIGS_PATH },
      tree,
      imports: oxfmtHost(hasJspi),
    };
    const run = hasJspi ? await runWasiAsync(command) : runWasi(command);
    await syncBack(ctx.fs, tree);
    return toExecResult(run);
  });
}
