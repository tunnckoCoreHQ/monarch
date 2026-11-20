import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "badges-wgw-lol",
    compatibilityDate: "2026-08-24",
    entrypoint: "src/index.ts",
    // A zone route, not a custom domain: wgw.lol hosts many subdomains on routes.
    triggers: [triggers.fetch({ pattern: "badges.wgw.lol/*", zone: "wgw.lol" })],
    workersDev: false,
    previewUrls: false,
    env: {
      // The deploy task passes the commit being deployed; local builds get "local".
      COMMIT_SHA: bindings.text(process.env.COMMIT_SHA ?? "local"),
      // A Depot organization token for pcnr2v598s; it lives on the Worker.
      BADGES_DEPOT_TOKEN: bindings.secret(),
    },
  },
});
