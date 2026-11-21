import { defineConfig } from "blume";
import { cloudflare } from "blume/deploy";

export default defineConfig({
  title: "zagora",
  description:
    "Type-safe, error-safe TypeScript functions that never throw, with Standard Schema validation and typed errors. No network layer, no routers.",
  github: {
    owner: "tunnckoCoreHQ",
    repo: "monarch",
    branch: "master",
    dir: "apps/zagora-docs",
  },
  theme: {
    accent: "teal",
  },
  navigation: {
    sidebar: { display: "group" },
  },
  footer: {
    copyright: "Released under the Apache-2.0 License.",
    links: [{ label: "npm", href: "https://www.npmjs.com/package/zagora" }],
  },
  // A static build: the Worker in cloudflare.config.ts serves dist/ as its assets.
  deployment: cloudflare({
    output: "static",
    site: "https://zagora-docs.equator-owl-studio.workers.dev",
  }),
});
