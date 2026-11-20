import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "x402-router",
    compatibilityDate: "2026-06-19",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    entrypoint: "@astrojs/cloudflare/entrypoints/server",
    // A zone route, not a custom domain: wgw.lol hosts many subdomains on routes.
    triggers: [triggers.fetch({ pattern: "x402-router.wgw.lol/*", zone: "wgw.lol" })],
    assets: {
      // The x402 facilitator API is served by the Worker; everything else is a static asset first.
      runWorkerFirst: ["/supported", "/verify", "/settle", "/health", "/healthz"],
    },
    env: {
      ASSETS: bindings.assets(),
    },
  },
});
