import { bindings, defineConfig, exports, triggers } from "cf/config";

const ORIGIN = "https://app.wgw.lol";
const WORKER = "app-wgw-lol";
const ACCOUNT_ID = "b3e23415ee0a455f5711bf02945bbc06";
// The account's Secrets Store; it holds the master keys and the automation token.
const SECRETS_STORE = "33bb32010b244646ac4822e7c109a5e9";
const EVENTS_QUEUE = "app-wgw-lol-events";
const NAMESPACE = "app-wgw-lol";

export default defineConfig({
  worker: {
    name: WORKER,
    compatibilityDate: "2026-09-28",
    // Calls to Triad on the same zone must take the public path, or Cloudflare answers 522.
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    entrypoint: "src/server.ts",
    // A zone route, not a custom domain: wgw.lol hosts many subdomains on routes.
    triggers: [
      triggers.fetch({ pattern: "app.wgw.lol/*", zone: "wgw.lol" }),
      // Artifacts events: pushes to each full repository, and account-level repo changes.
      triggers.queue({ name: EVENTS_QUEUE, maxBatchSize: 20, maxBatchTimeout: 2, maxRetries: 3 }),
      // Hourly upkeep: missing push subscriptions and expired sign-in rows.
      triggers.scheduled({ schedule: "17 * * * *" }),
    ],
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
      ARTIFACTS: bindings.artifacts({ namespace: NAMESPACE }),
      ARTIFACTS_NAMESPACE: bindings.text(NAMESPACE),
      REPO: bindings.durableObject({ worker: WORKER, exportName: "Repo" }),
      READY: bindings.workflow({
        name: "app-wgw-lol-repo-ready",
        worker: WORKER,
        exportName: "RepoReady",
      }),
      // Accounts, tokens, repository metadata, pull requests, environments, and activity.
      DB: bindings.d1({ name: "app-wgw-lol", id: "083f7b02-3ae2-49bd-b7f2-184d2927fec2" }),
      // Mirror objects over 1 MB, which do not fit in a Durable Object SQLite row, and the
      // rendered repository preview cards.
      GIT: bindings.r2({ name: "app-wgw-lol-git" }),
      // Browser Rendering: draws a public repository's preview card, once per push.
      BROWSER: bindings.browser(),
      // Short-lived sign-in state and passkey challenges.
      CACHE: bindings.kv({ id: "62b8e0bae315469ab347a692df78bf79" }),
      // Pull request summaries and code search embeddings.
      AI: bindings.ai(),
      // Every Workers AI call goes through this AI Gateway: analytics, caching, no prompt logs.
      AI_GATEWAY: bindings.text("app-wgw-lol"),
      // Code search: one vector per chunk of a file at the default branch tip.
      CODE: bindings.vectorize({ name: "app-wgw-lol-code" }),
      // Producer for the events queue; the app sends itself code search index jobs.
      EVENTS: bindings.queue({ name: EVENTS_QUEUE }),
      // Counts of clones, fetches, and pushes per repository.
      METRICS: bindings.analyticsEngineDataset({ name: "app_wgw_lol_git" }),
      // Sign-in, device-code, agent-registration, and git-token endpoints.
      LIMITER: bindings.rateLimit({ namespace: "4201", simple: { limit: 30, period: 60 } }),
      ASSETS: bindings.assets(),
      // Secrets Store: the key that wraps each repository's secret key.
      SECRETS_KEK: bindings.secretsStoreSecret({
        storeId: SECRETS_STORE,
        secretName: "app_wgw_lol_secrets_kek",
      }),
      // Secrets Store: the ES256 private key, PKCS#8 PEM, that signs auth.md identity assertions.
      SIGNING_KEY: bindings.secretsStoreSecret({
        storeId: SECRETS_STORE,
        secretName: "app_wgw_lol_signing_key",
      }),
      // Secrets Store: an account API token limited to Queues Write. It creates and deletes the
      // per-repository push subscriptions.
      EVENTS_TOKEN: bindings.secretsStoreSecret({
        storeId: SECRETS_STORE,
        secretName: "app_wgw_lol_events_token",
      }),
      ACCOUNT_ID: bindings.text(ACCOUNT_ID),
      // The queue that receives Artifacts events; its ID goes into each push subscription.
      EVENTS_QUEUE_ID: bindings.text("8266fc1aac8c40fd8a807a5a4fbcc872"),
    },
  },
});
