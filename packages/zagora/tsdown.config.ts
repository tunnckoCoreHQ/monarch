import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/errors.ts", "src/types.ts", "src/utils.ts"],
  format: "esm",
  platform: "node",
  // tsdown defaults to .mjs on node; the exports map and the dist test expect .js and .d.ts.
  fixedExtension: false,
  dts: true,
  clean: true,
});
