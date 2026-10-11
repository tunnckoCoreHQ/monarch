import { bindings, defineConfig, exports, triggers } from "cf/config";

const ORIGIN = "https://app.wgw.lol";
const WORKER = "app-wgw-lol";

export default defineConfig({
  worker: {
    name: WORKER,
    compatibilityDate: "2026-09-28",
    // Calls to Triad on the same zone must take the public path, or Cloudflare answers 522.
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    entrypoint: "src/server.ts",
    // A zone route, not a custom domain: wgw.lol hosts many subdomains on routes.
    triggers: [triggers.fetch({ pattern: "app.wgw.lol/*", zone: "wgw.lol" })],
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true, headSamplingRate: 1 },
    exports: {
      // One SQLite Durable Object per repository mirrors its Artifacts repos and computes the
      // public projection, merges, and API commits.
      Repo: exports.durableObject({ storage: "sqlite" }),
      // Waits until an Artifacts import or fork is ready, then syncs the mirror.
      RepoReady: exports.workflow({ name: "app-wgw-lol-repo-ready" }),
    },
    env: {
      ORIGIN: bindings.text<string>(ORIGIN),
      TRIAD_ISSUER: bindings.text("https://triad-auth-nightly.wgw.lol/api/auth"),
      // The deploy task passes the commit being deployed; local builds get "local".
      COMMIT_SHA: bindings.text(process.env.COMMIT_SHA ?? "local"),
      // Git storage: two Artifacts repos per wgw repo, the full one and its public projection.
      ARTIFACTS: bindings.artifacts({ namespace: "app-wgw-lol" }),
      REPO: bindings.durableObject({ worker: WORKER, exportName: "Repo" }),
      READY: bindings.workflow({
        name: "app-wgw-lol-repo-ready",
        worker: WORKER,
        exportName: "RepoReady",
      }),
      // Accounts, tokens, repository metadata, pull requests, environments, and activity.
      DB: bindings.d1({ name: "app-wgw-lol", id: "083f7b02-3ae2-49bd-b7f2-184d2927fec2" }),
      // Mirror objects over 1 MB, which do not fit in a Durable Object SQLite row.
      GIT: bindings.r2({ name: "app-wgw-lol-git" }),
      // Short-lived sign-in state and passkey challenges.
      CACHE: bindings.kv({ id: "62b8e0bae315469ab347a692df78bf79" }),
      // Pull request summaries.
      AI: bindings.ai(),
      // Counts of clones, fetches, and pushes per repository.
      METRICS: bindings.analyticsEngineDataset({ name: "app_wgw_lol_git" }),
      // Sign-in, device-code, agent-registration, and git-token endpoints.
      LIMITER: bindings.rateLimit({ namespace: "4201", simple: { limit: 30, period: 60 } }),
      ASSETS: bindings.assets(),
      // AES-GCM key for repository secrets: 32 random bytes, base64.
      SECRETS_KEY: bindings.secret(),
      // ES256 private key, PKCS#8 PEM, that signs auth.md identity assertions.
      SIGNING_KEY: bindings.secret(),
    },
  },
});
