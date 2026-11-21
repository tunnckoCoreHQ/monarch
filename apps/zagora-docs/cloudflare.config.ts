import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "zagora-docs",
    compatibilityDate: "2026-10-01",
    entrypoint: "src/index.ts",
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
