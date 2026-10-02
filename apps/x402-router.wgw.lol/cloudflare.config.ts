import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "wgw-x402-router",
    compatibilityDate: "2026-06-19",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    entrypoint: "@astrojs/cloudflare/entrypoints/server",
    observability: { enabled: true },
    assets: {
      // The x402 facilitator API is served by the Worker; everything else is a static asset first.
      runWorkerFirst: ["/supported", "/verify", "/settle", "/health", "/healthz"],
    },
    env: {
      ASSETS: bindings.assets(),
    },
  },
});
