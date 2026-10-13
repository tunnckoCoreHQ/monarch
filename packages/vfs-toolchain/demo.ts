// Demo: `ultracite fix --type-aware --type-check` on packages/zagora, entirely on a just-bash
// in-memory filesystem. oxlint, oxfmt, and tsgolint are the real CLIs compiled to wasm32-wasip1;
// their only filesystem is the VFS. Run with JSPI so oxfmt can hand markdown to Prettier:
//
//   node --experimental-wasm-jspi demo.ts
//
// Needs wasm/{oxlint,oxfmt,tsgolint}.wasm and fixtures/{zagora.snapshot,presets}.json
// (`node scripts/snapshot-zagora.ts && node scripts/bundle-presets.ts`). The same commands run in
// a Worker: see worker/entry.ts and `node worker/dev.ts "<command>"`.
import { Bash } from "just-bash/browser";

import { hasJspi, toolchainCommands } from "./src/index.ts";
import { loadEngines, loadZagora, nodeConfigEvaluator } from "./test/node-host.ts";

const fs = await loadZagora();
const bash = new Bash({
  fs,
  cwd: "/repo",
  customCommands: toolchainCommands({
    engines: loadEngines(),
    evaluateConfig: nodeConfigEvaluator(),
  }),
});

const run = async (command: string): Promise<void> => {
  console.log(`\n$ ${command}`);
  const result = await bash.exec(command);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.log(`[exit ${result.exitCode}]`);
};

if (!hasJspi) {
  console.log("(no JSPI: oxfmt skips the files it formats with Prettier, such as README.md)");
}

// A file with lint and format problems, written into the VFS like any other.
await fs.writeFile(
  "/repo/packages/zagora/src/demo.ts",
  "var count = 1\nexport async function load() { return count }\nif (count == 2) { load() }\n",
);

await run("oxfmt --check packages/zagora");
await run("ultracite fix --type-aware --type-check packages/zagora | tail -n 20");
await run("cat packages/zagora/src/demo.ts");
await run("oxlint --type-aware -f unix packages/zagora/src | grep demo.ts | sort");
