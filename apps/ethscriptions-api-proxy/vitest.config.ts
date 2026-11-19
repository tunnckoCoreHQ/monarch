import { defineConfig } from "vitest/config";

// The tests run in Node against the handlers, so they skip the Cloudflare plugin in vite.config.ts.
export default defineConfig({});
