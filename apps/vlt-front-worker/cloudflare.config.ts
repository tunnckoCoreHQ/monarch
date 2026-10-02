import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "vlt-front-worker",
    compatibilityDate: "2026-08-24",
    entrypoint: "src/index.ts",
    workersDev: false,
    observability: { enabled: true, headSamplingRate: 1 },
    triggers: [triggers.fetch({ pattern: "npm.wgw.lol/*", zone: "wgw.lol" })],
    env: {
      ALLOWED_GITHUB_LOGIN: bindings.text("tunnckoCore"),
      // Workers Builds injects the commit being built; local builds get "local".
      COMMIT_SHA: bindings.text(process.env.WORKERS_CI_COMMIT_SHA ?? "local"),
      // VLT service tokens and the upstream registry live on the Worker; `.dev.vars` holds local values.
      READ_TOKEN: bindings.secret(),
      WRITE_TOKEN: bindings.secret(),
      UPSTREAM_URL: bindings.secret(),
    },
  },
});
