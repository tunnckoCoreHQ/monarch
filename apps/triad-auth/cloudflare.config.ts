import { bindings, defineConfig, triggers } from "cf/config";

// One Worker per mode. The default (production) build targets `triad-auth`; Workers Builds passes
// `--mode nightly` from `master` to target `triad-auth-nightly`. Each Worker has its own D1 database,
// its own secrets, and its own AUTH_ORIGIN. Secrets are set on the Worker and are not declared here.
const workers = {
  production: {
    name: "triad-auth",
    database: { name: "triad-auth", id: "40220009-d502-4afd-ab7b-54495016720f" },
  },
  nightly: {
    name: "triad-auth-nightly",
    database: { name: "triad-auth-nightly", id: "c4c8e874-a463-4c22-8389-8911627c055d" },
  },
} as const;

export default defineConfig(({ mode }) => {
  const target = mode === "nightly" ? workers.nightly : workers.production;
  const host = `${target.name}.wgw.lol`;

  return {
    worker: {
      name: target.name,
      compatibilityDate: "2026-07-09",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      entrypoint: "src/index.ts",
      workersDev: false,
      previewUrls: false,
      assets: {
        htmlHandling: "drop-trailing-slash",
        notFoundHandling: "404-page",
        runWorkerFirst: false,
      },
      triggers: [triggers.fetch({ pattern: `${host}/*`, zone: "wgw.lol" })],
      env: {
        AUTH_ORIGIN: bindings.text(`https://${host}`),
        DB: bindings.d1(target.database),
        ASSETS: bindings.assets(),
      },
    },
  };
});
