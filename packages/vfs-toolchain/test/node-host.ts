// Node stand-ins for what a Worker gets from its bundle and bindings: compiled engines, the
// zagora snapshot, and a config evaluator (a Worker uses a Dynamic Worker for that).
import { readFileSync } from "node:fs";

import { InMemoryFs } from "just-bash/browser";
import { rolldown } from "rolldown";

import type { ConfigEvaluator } from "../src/js-config.ts";
import { loadSnapshot, type Snapshot } from "../src/snapshot.ts";
import type { Engines } from "../src/toolchain.ts";

const root = new URL("../", import.meta.url);

const compile = (name: string) =>
  new WebAssembly.Module(readFileSync(new URL(`wasm/${name}`, root)));

export function loadEngines(): Engines {
  return {
    oxfmt: compile("oxfmt.wasm"),
    oxlint: compile("oxlint.wasm"),
    tsgolint: compile("tsgolint.wasm"),
  };
}

export async function loadZagora(): Promise<InMemoryFs> {
  const fs = new InMemoryFs();
  await loadSnapshot(
    fs,
    JSON.parse(readFileSync(new URL("fixtures/zagora.snapshot.json", root), "utf-8")) as Snapshot,
  );
  return fs;
}

/** Bundle the config with the preset modules a Worker would hand to its Dynamic Worker, then import it. */
export function nodeConfigEvaluator(): ConfigEvaluator {
  const presets = JSON.parse(
    readFileSync(new URL("fixtures/presets.json", root), "utf-8"),
  ) as Record<string, string>;
  return async (file, source) => {
    const bundle = await rolldown({
      input: "config.js",
      platform: "node",
      logLevel: "silent",
      plugins: [
        {
          name: "config-modules",
          resolveId: (id) => (id === "config.js" || id in presets ? id : null),
          load: (id) => (id === "config.js" ? source : (presets[id] ?? null)),
        },
      ],
    });
    try {
      const { output } = await bundle.generate({ format: "es", codeSplitting: false });
      const module = (await import(
        `data:text/javascript;base64,${Buffer.from(output[0].code).toString("base64")}`
      )) as {
        default: unknown;
      };
      return typeof module.default === "function"
        ? await (module.default as () => unknown)()
        : module.default;
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`, { cause: error });
    }
  };
}
