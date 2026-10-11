import type { BrowserWorker } from "@cloudflare/puppeteer";
import type { InferEnv, UnwrapConfig } from "cf/config";

import type config from "../../cloudflare.config";
import type { Repo } from "./repo-object";

// Bindings are inferred from cloudflare.config.ts, so the config is the single source of truth.
type WorkerConfig = UnwrapConfig<UnwrapConfig<typeof config>["worker"]>;

// The config types a Vectorize binding as the deprecated V1 index; the code index is V2.
// Puppeteer wants the browser binding's fetch to match the global fetch, which Bun's types extend.
export type Env = Omit<InferEnv<WorkerConfig>, "REPO" | "CODE" | "BROWSER"> & {
  REPO: DurableObjectNamespace<Repo>;
  CODE: Vectorize;
  BROWSER: BrowserWorker;
};
