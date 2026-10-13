import type { IFileSystem } from "just-bash";

/**
 * JavaScript configs (`oxlint.config.ts`, `oxfmt.config.ts`) are modules: the tools import them and
 * read the default export. On the VFS that import happens in a Dynamic Worker (a Worker cannot
 * evaluate code itself), whose modules are the config and the presets it may import.
 */
export type ConfigEvaluator = (file: string, source: string) => Promise<unknown>;

/** The subset of the Worker Loader binding (`worker_loaders`) used here. */
export interface WorkerLoaderBinding {
  load(code: {
    compatibilityDate: string;
    mainModule: string;
    modules: Record<string, string | { js: string }>;
    globalOutbound?: null;
  }): { getEntrypoint(): { fetch(request: Request): Promise<Response> } };
}

const MAIN = `import config from "./config.js";
export default {
  async fetch() {
    const value = typeof config === "function" ? await config() : config;
    return Response.json(value ?? null);
  },
};
`;

/**
 * Evaluate configs in a fresh, network-less Dynamic Worker. `presets` maps import specifiers
 * (`ultracite/oxlint/core`, `oxlint`) to bundled module code (see scripts/bundle-presets.ts).
 */
export function dynamicWorkerEvaluator(
  loader: WorkerLoaderBinding,
  presets: Record<string, string>,
): ConfigEvaluator {
  return async (file, source) => {
    const worker = loader.load({
      compatibilityDate: "2026-09-30",
      mainModule: "main.js",
      // Presets are named by their import specifier, so the type is given explicitly.
      modules: {
        ...Object.fromEntries(
          Object.entries(presets).map(([specifier, js]) => [specifier, { js }]),
        ),
        "main.js": MAIN,
        "config.js": source,
      },
      globalOutbound: null,
    });
    const response = await worker.getEntrypoint().fetch(new Request("http://config/"));
    if (!response.ok) {
      throw new Error(`${file}: ${await response.text()}`);
    }
    return response.json();
  };
}

/** Evaluate every JavaScript config among `files`, keyed by path, for the tools to read. */
export async function evaluateConfigs(
  fs: IFileSystem,
  files: readonly string[],
  evaluate: ConfigEvaluator,
): Promise<Record<string, unknown>> {
  const configs: Record<string, unknown> = {};
  for (const file of files) {
    configs[file] = await evaluate(file, await fs.readFile(file));
  }
  return configs;
}
