import { defineConfig } from "cf/config";

// An assets-only Worker. `blume build` writes the static site to dist/, and vite.config.ts makes it the assets.
export default defineConfig({
  worker: {
    name: "zagora-docs",
    compatibilityDate: "2026-11-01",
    // Served on workers.dev for now, at the `site` URL in blume.config.ts.
    workersDev: true,
    previewUrls: false,
    assets: {
      // Blume links pages without a trailing slash.
      htmlHandling: "drop-trailing-slash",
      notFoundHandling: "404-page",
    },
  },
});
