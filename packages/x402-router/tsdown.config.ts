import { defineConfig } from "tsdown";

// One bundle per entry. Dependencies stay external; devDependencies are bundled in.
export default defineConfig({
  entry: ["src/index.ts", "src/cdp.ts", "src/payai.ts"],
  format: "esm",
  platform: "neutral",
  dts: true,
  clean: true,
});
