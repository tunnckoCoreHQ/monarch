import { existsSync } from "node:fs";

import { Bash } from "just-bash/browser";
import { describe, expect, test } from "vitest";

import { hasJspi, toolchainCommands } from "../src/index.ts";
import { loadEngines, loadZagora, nodeConfigEvaluator } from "./node-host.ts";

// The engines and the zagora snapshot are local build artifacts, not committed (see README).
const artifacts = [
  "wasm/oxlint.wasm",
  "wasm/oxfmt.wasm",
  "wasm/tsgolint.wasm",
  "fixtures/zagora.snapshot.json",
  "fixtures/presets.json",
];
const ready = artifacts.every((file) => existsSync(new URL(`../${file}`, import.meta.url)));

async function zagoraShell() {
  const fs = await loadZagora();
  const bash = new Bash({
    fs,
    cwd: "/repo",
    customCommands: toolchainCommands({
      engines: loadEngines(),
      evaluateConfig: nodeConfigEvaluator(),
    }),
  });
  return { fs, bash };
}

describe.skipIf(!ready)("the toolchain on packages/zagora, in memory", () => {
  test("oxfmt --check finds zagora formatted, using the repository oxfmt.config.ts", async () => {
    const { bash } = await zagoraShell();
    const result = await bash.exec("oxfmt --check packages/zagora");
    expect(result.stdout).toContain("All matched files use the correct format.");
    // README.md is formatted by Prettier, which needs JSPI to be called from wasm.
    expect(result.stdout).toContain(`on ${hasJspi ? 20 : 19} files`);
    expect(result.exitCode).toBe(0);
  });

  test("oxlint with the repository config passes on zagora, type-checking included", async () => {
    const { bash } = await zagoraShell();
    const result = await bash.exec("oxlint -f json packages/zagora");
    const report = JSON.parse(result.stdout) as { diagnostics: unknown[]; number_of_files: number };
    // `options.typeAware/typeCheck` in oxlint.config.ts make this a type-aware run with tsgolint.
    expect(report.diagnostics).toEqual([]);
    expect(report.number_of_files).toBe(16);
    expect(result.stderr).toContain("JS plugins are not supported");
    expect(result.exitCode).toBe(0);
  }, 120_000);

  test("ultracite fix --type-aware --type-check fixes and formats files on the VFS", async () => {
    const { fs, bash } = await zagoraShell();
    await fs.writeFile(
      "/repo/packages/zagora/src/demo.ts",
      "var count = 1\nexport async function load() { return count }\nif (count === 2) { load() }\n",
    );
    const result = await bash.exec("ultracite fix --type-aware --type-check packages/zagora");
    expect(await fs.readFile("/repo/packages/zagora/src/demo.ts")).toBe(
      "const count = 1;\nexport async function load() {\n  return count;\n}\nif (count === 2) {\n  load();\n}\n",
    );
    // tsgolint ran over the fixed file: the floating promise is a type-aware finding.
    expect(result.stdout).toContain("typescript(no-floating-promises)");
    expect(result.exitCode).toBe(1);
  }, 240_000);
});
