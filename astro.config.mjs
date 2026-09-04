import cloudflare from "@astrojs/cloudflare";
import { defineConfig, sessionDrivers } from "astro/config";

export default defineConfig({
  // WRANGLER_CONFIG selects the Worker config the build targets; unset means wrangler.toml.
  adapter: cloudflare({ configPath: process.env.WRANGLER_CONFIG, imageService: "passthrough" }),
  output: "server",
  // Triad owns browser sessions in D1; this prevents an unused KV binding.
  session: { driver: sessionDrivers.lruCache() },
  trailingSlash: "never",
  build: { format: "directory" },
});
