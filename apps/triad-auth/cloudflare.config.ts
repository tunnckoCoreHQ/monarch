import { bindings, defineConfig, triggers } from "cf/config";

// One Worker per mode. The default (production) build targets `triad-auth`; `deploy:nightly` passes
// `--mode nightly` to target `triad-auth-nightly`. Each Worker has its own D1
// database, its own secrets, and its own AUTH_ORIGIN. The deploy scripts apply the pending files in
// `migrations/` before each deploy.
export const workers = {
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
      // A zone route, not a custom domain: wgw.lol hosts many subdomains on routes.
      triggers: [triggers.fetch({ pattern: `${host}/*`, zone: "wgw.lol" })],
      workersDev: false,
      previewUrls: false,
      observability: { enabled: true },
      // `astro build` prerenders every page; the Worker serves the auth API and the built assets.
      assets: {
        htmlHandling: "drop-trailing-slash",
        notFoundHandling: "404-page",
        runWorkerFirst: false,
      },
      env: {
        // Typed as string, so tests and local tools can pass any origin.
        AUTH_ORIGIN: bindings.text<string>(`https://${host}`),
        DB: bindings.d1(target.database),
        ASSETS: bindings.assets(),
        // The twelve secrets live on each Worker; `.env` holds local values.
        BETTER_AUTH_SECRET: bindings.secret(),
        IDENTIFIER_SECRET: bindings.secret(),
        RATE_LIMIT_SECRET: bindings.secret(),
        ENCRYPTION_SECRETS: bindings.secret(),
        GOOGLE_CLIENT_ID: bindings.secret(),
        GOOGLE_CLIENT_SECRET: bindings.secret(),
        GITHUB_CLIENT_ID: bindings.secret(),
        GITHUB_CLIENT_SECRET: bindings.secret(),
        TWITTER_CLIENT_ID: bindings.secret(),
        TWITTER_CLIENT_SECRET: bindings.secret(),
        AGENTID_CLIENT_ID: bindings.secret(),
        AGENTID_CLIENT_SECRET: bindings.secret(),
      },
    },
  };
});
