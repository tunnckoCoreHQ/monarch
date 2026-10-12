import { defineConfig } from "vitest/config";

// The tests run in Node against the git core, so they skip the Cloudflare plugin in vite.config.ts.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
