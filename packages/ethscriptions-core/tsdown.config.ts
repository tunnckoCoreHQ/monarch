import { defineConfig } from "tsdown";

// One bundle. Dependencies stay external.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "neutral",
  dts: true,
  clean: true,
});
