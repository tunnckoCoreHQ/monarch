// Development helper: bundle the config presets a project's `oxlint.config.ts` / `oxfmt.config.ts`
// can import (ultracite's) into self-contained ES modules, keyed by import specifier. A Worker
// cannot import packages at runtime, so it evaluates a config in a Dynamic Worker whose modules
// are the config itself plus these.
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "rolldown";

// `ultracite/oxfmt` is `<package>/config/oxfmt/index.mjs`.
const ultraciteDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.resolve("ultracite/oxfmt"))),
  "../..",
);
const OUT = path.resolve(import.meta.dirname, "../fixtures/presets.json");

// `defineConfig` from oxlint and oxfmt is the identity function; the packages load native bindings.
const DEFINE_CONFIG = "export function defineConfig(config) { return config; }\n";

const specifiers = [
  "ultracite/oxfmt",
  ...readdirSync(path.join(ultraciteDir, "config/oxlint")).map(
    (name) => `ultracite/oxlint/${name}`,
  ),
];

const presets: Record<string, string> = { oxlint: DEFINE_CONFIG, oxfmt: DEFINE_CONFIG };
for (const specifier of specifiers) {
  try {
    const result = await build({
      input: "virtual:entry",
      platform: "neutral",
      write: false,
      logLevel: "silent",
      // A preset that names a JS plugin by file location (`new URL("plugin.mjs", import.meta.url)`)
      // gets a stable placeholder; the toolchain does not load JS plugins.
      transform: {
        define: {
          "import.meta.url": JSON.stringify(`file:///node_modules/${specifier}/index.mjs`),
        },
      },
      plugins: [
        {
          name: "entry",
          resolveId(id) {
            if (id === "virtual:entry") {
              return id;
            }
            if (id === "oxlint" || id === "oxfmt") {
              return `\0define-config`;
            }
            return null;
          },
          load(id) {
            if (id === "virtual:entry") {
              return `export { default } from ${JSON.stringify(specifier)};\n`;
            }
            if (id === "\0define-config") {
              return DEFINE_CONFIG;
            }
            return null;
          },
        },
      ],
      output: { format: "es", codeSplitting: false },
    });
    presets[specifier] = result.output[0].code;
  } catch (error) {
    console.warn(`skipped ${specifier}: ${String(error).split("\n")[0]}`);
  }
}

writeFileSync(OUT, JSON.stringify(presets));
console.log(`${Object.keys(presets).length} presets -> ${path.relative(process.cwd(), OUT)}`);
