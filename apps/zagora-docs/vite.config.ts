import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// `blume build` writes the static site to dist/, and the Worker in src/index.ts serves it as its assets.
export default defineConfig({
  publicDir: "dist",
  plugins: [cloudflare()],
});
