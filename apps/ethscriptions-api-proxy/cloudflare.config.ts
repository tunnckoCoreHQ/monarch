import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "ethscriptions-api-proxy",
    compatibilityDate: "2026-08-24",
    entrypoint: "src/index.ts",
    // Zone routes: the cf config has no custom domains, so each host has a proxied DNS record.
    triggers: [
      triggers.fetch({ pattern: "api.calldata.space/*", zone: "calldata.space" }),
      triggers.fetch({ pattern: "sepolia-api.calldata.space/*", zone: "calldata.space" }),
    ],
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true, headSamplingRate: 1 },
    env: {
      // The deploy task passes the commit being deployed; local builds get "local".
      COMMIT_SHA: bindings.text(process.env.COMMIT_SHA ?? "local"),
    },
  },
});
