import type { CustomCommand } from "just-bash";

import { oxfmtCommand } from "./oxfmt.ts";
import { oxlintCommand } from "./oxlint.ts";
import type { ToolchainOptions } from "./toolchain.ts";
import { ultraciteCommand } from "./ultracite.ts";

export {
  type ConfigEvaluator,
  dynamicWorkerEvaluator,
  type WorkerLoaderBinding,
} from "./js-config.ts";
export { oxfmtCommand } from "./oxfmt.ts";
export { oxlintCommand } from "./oxlint.ts";
export { loadSnapshot, type Snapshot } from "./snapshot.ts";
export type { Engines, ToolchainOptions } from "./toolchain.ts";
export { ultraciteCommand } from "./ultracite.ts";
export { hasJspi } from "./wasi.ts";

/** `oxlint`, `oxfmt`, and `ultracite` as just-bash custom commands. */
export function toolchainCommands(options: ToolchainOptions): CustomCommand[] {
  return [oxlintCommand(options), oxfmtCommand(options), ultraciteCommand];
}
