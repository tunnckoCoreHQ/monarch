import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/errors.ts", "src/types.ts", "src/utils.ts"],
  format: "esm",
  platform: "node",
  fixedExtension: false,
  dts: true,
  clean: true,
});
