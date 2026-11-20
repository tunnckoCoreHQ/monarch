import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "vlt-npm-wgw-lol",
    compatibilityDate: "2026-08-24",
    entrypoint: "src/index.ts",
    // A zone route, not a custom domain: wgw.lol hosts many subdomains on routes.
    triggers: [triggers.fetch({ pattern: "npm.wgw.lol/*", zone: "wgw.lol" })],
    workersDev: false,
    previewUrls: false,
    env: {
      ALLOWED_GITHUB_LOGIN: bindings.text("tunnckoCore"),
      // The deploy task passes the commit being deployed; local builds get "local".
      COMMIT_SHA: bindings.text(process.env.COMMIT_SHA ?? "local"),
      // VLT service tokens and the upstream registry live on the Worker; `.env` holds local values.
      VLT_READ_TOKEN: bindings.secret(),
      VLT_WRITE_TOKEN: bindings.secret(),
      VLT_UPSTREAM_URL: bindings.secret(),
    },
  },
});
