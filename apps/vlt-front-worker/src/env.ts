import type { InferEnv, UnwrapConfig } from "cf/config";
import type config from "../cloudflare.config";

// Bindings are inferred from cloudflare.config.ts, so the config is the single source of truth.
type WorkerConfig = UnwrapConfig<UnwrapConfig<typeof config>["worker"]>;

export type Env = InferEnv<WorkerConfig>;
