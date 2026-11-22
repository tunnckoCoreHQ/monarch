import { bindings, defineConfig } from "cf/config";

// `blume build` writes the static site to dist/, and vite.config.ts makes it the Worker's assets.
// The Worker runs first on every request, so it can answer `Accept: text/markdown` and API 404s.
export default defineConfig({
  worker: {
    name: "zagora-docs",
    compatibilityDate: "2026-10-01",
    entrypoint: "src/index.ts",
    // Served on workers.dev for now, at the `site` URL in blume.config.ts.
    workersDev: true,
    previewUrls: false,
    assets: {
      // Blume links pages without a trailing slash.
      htmlHandling: "drop-trailing-slash",
      notFoundHandling: "404-page",
      runWorkerFirst: true,
    },
    env: {
      ASSETS: bindings.assets(),
    },
  },
});
