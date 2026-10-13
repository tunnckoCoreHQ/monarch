// Bundle worker/entry.ts and run it in local workerd, the runtime Cloudflare Workers use.
// Usage: node worker/dev.ts "<shell command line>"   (runs it in /repo on the zagora VFS)
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { build } from "rolldown";

const here = import.meta.dirname;
const out = path.join(here, "../.worker");
mkdirSync(path.join(out, "modules"), { recursive: true });

await build({
  input: path.join(here, "entry.ts"),
  platform: "browser",
  external: [/\.\/modules\//, /^node:/],
  output: { file: path.join(out, "entry.js"), format: "es", codeSplitting: false },
  logLevel: "warn",
});
for (const engine of ["tsgolint.wasm", "oxfmt.wasm", "oxlint.wasm"]) {
  copyFileSync(path.join(here, "../wasm", engine), path.join(out, "modules", engine));
}
copyFileSync(
  path.join(here, "../fixtures/zagora.snapshot.json"),
  path.join(out, "modules/zagora.snapshot.json.txt"),
);
copyFileSync(
  path.join(here, "../fixtures/presets.json"),
  path.join(out, "modules/presets.json.txt"),
);

const port = 8790;
writeFileSync(
  path.join(out, "config.capnp"),
  `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = .worker)],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);
const worker :Workerd.Worker = (
  modules = [
    (name = "entry.js", esModule = embed "entry.js"),
    (name = "./modules/tsgolint.wasm", wasm = embed "modules/tsgolint.wasm"),
    (name = "./modules/oxfmt.wasm", wasm = embed "modules/oxfmt.wasm"),
    (name = "./modules/oxlint.wasm", wasm = embed "modules/oxlint.wasm"),
    (name = "./modules/zagora.snapshot.json.txt", text = embed "modules/zagora.snapshot.json.txt"),
    (name = "./modules/presets.json.txt", text = embed "modules/presets.json.txt"),
  ],
  compatibilityDate = "2026-09-30",
  bindings = [(name = "LOADER", workerLoader = ())],
);
`,
);

const workerdBin = createRequire(import.meta.url).resolve("workerd/bin/workerd");
const child = spawn(workerdBin, ["serve", "config.capnp", "--experimental"], {
  cwd: out,
  stdio: ["ignore", "inherit", "inherit"],
});
try {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/__ping`);
      break;
    } catch (error) {
      if (attempt > 100) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const started = performance.now();
  const command = process.argv[2] ?? "oxfmt --check packages/zagora";
  const response = await fetch(`http://127.0.0.1:${port}/run?cmd=${encodeURIComponent(command)}`);
  // SAFETY: worker/entry.ts answers with this shape; anything else (an error page) fails to parse.
  const body = (await response.json().catch(() => null)) as {
    stdout: string;
    stderr: string;
    exitCode: number;
    ms: number;
  } | null;
  if (body) {
    process.stdout.write(body.stdout);
    process.stderr.write(body.stderr);
    console.log(`[workerd] exit ${body.exitCode} in ${body.ms} ms`);
  } else {
    console.log(`[workerd] HTTP ${response.status}`);
  }
  console.log(`${Math.round(performance.now() - started)} ms`);
} finally {
  child.kill();
}
