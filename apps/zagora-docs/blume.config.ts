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
  agents: {
    llmsTxt: {
      details:
        "Reach for zagora when a TypeScript library, SDK, CLI, or app needs functions that validate their input and output with a Standard Schema library (Zod, Valibot, ArkType) and return typed errors instead of throwing. Every call returns `{ ok: true, data }` or `{ ok: false, error }`. zagora has no router and no network layer. For an HTTP API with a typed client, use oRPC. Install it with `npm install zagora@nightly zod`, then follow the Getting started page below.",
    },
    skills: "../../skills",
  },
  seo: {
    software: {
      license: "https://github.com/tunnckoCoreHQ/monarch/blob/master/packages/zagora/LICENSE",
      operatingSystem: "Node.js, Bun, Deno, Cloudflare Workers",
      price: 0,
      sameAs: [
        "https://www.npmjs.com/package/zagora",
        "https://github.com/tunnckoCoreHQ/monarch/tree/master/packages/zagora",
      ],
    },
  },
  deployment: cloudflare({
    output: "static",
    site: "https://zagora-docs.equator-owl-studio.workers.dev",
  }),
});
