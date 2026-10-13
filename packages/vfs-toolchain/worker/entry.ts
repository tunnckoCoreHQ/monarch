// A Worker that loads packages/zagora (with the repository configs it uses) into a just-bash VFS
// and runs the toolchain commands on it. Engines arrive as compiled wasm modules, the project as
// a snapshot module, and JS configs are evaluated in Dynamic Workers. Nothing touches a disk.
//
//   GET /run?cmd=<shell command line>   runs it in /repo and returns stdout, stderr, exit code
import { Bash, InMemoryFs } from "just-bash/browser";

import { dynamicWorkerEvaluator, type WorkerLoaderBinding } from "../src/js-config.ts";
import { oxfmtCommand } from "../src/oxfmt.ts";
import { oxlintCommand } from "../src/oxlint.ts";
import { loadSnapshot, type Snapshot } from "../src/snapshot.ts";
import { ultraciteCommand } from "../src/ultracite.ts";
import oxfmt from "./modules/oxfmt.wasm";
import oxlint from "./modules/oxlint.wasm";
import presetsText from "./modules/presets.json.txt";
import tsgolint from "./modules/tsgolint.wasm";
import snapshotText from "./modules/zagora.snapshot.json.txt";

// SAFETY: scripts/bundle-presets.ts writes this module: specifier → module code.
const presets = JSON.parse(presetsText) as Record<string, string>;

export default {
  async fetch(request: Request, env: { LOADER: WorkerLoaderBinding }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__ping") {
      return new Response("pong");
    }
    const fs = new InMemoryFs();
    // SAFETY: scripts/snapshot-zagora.ts writes this module as a Snapshot.
    await loadSnapshot(fs, JSON.parse(snapshotText) as Snapshot);
    const toolchain = {
      engines: { oxfmt, oxlint, tsgolint },
      evaluateConfig: dynamicWorkerEvaluator(env.LOADER, presets),
    };
    const bash = new Bash({
      fs,
      cwd: "/repo",
      customCommands: [oxlintCommand(toolchain), oxfmtCommand(toolchain), ultraciteCommand],
    });
    const started = Date.now();
    const result = await bash.exec(url.searchParams.get("cmd") ?? "oxfmt --check packages/zagora");
    return Response.json({ ...result, ms: Date.now() - started });
  },
};
