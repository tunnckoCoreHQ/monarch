import cloudflare from "@astrojs/cloudflare";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, sessionDrivers } from "astro/config";

const noAdapter = process.env.WGW_ASTRO_NO_ADAPTER === "1";

// https://astro.build/config
export default defineConfig({
  // Starlight prerenders through satteri, whose workerd build needs a WASM package pnpm does not
  // install on this platform, so prerendering runs in Node. The deployed Worker is unaffected.
  ...(noAdapter ? {} : { adapter: cloudflare({ prerenderEnvironment: "node" }) }),
  integrations: [
    starlight({
      customCss: ["./src/styles.css"],
      editLink: {
        baseUrl:
          "https://github.com/tunnckoCoreHQ/monarch/tree/master/apps/x402-router.wgw.lol/src/content/docs/",
      },
      sidebar: [
        {
          items: ["docs/index", "docs/getting-started", "docs/integration"],
          label: "Start",
        },
        {
          items: ["docs/upstreams", "docs/self-hosting", "docs/license"],
          label: "Operate",
        },
      ],
      title: "x402-router",
    }),
  ],
  output: "server",
  session: { driver: sessionDrivers.lruCache() },
  security: {
    checkOrigin: false,
  },
  site: "https://x402-router.wgw.lol",
  vite: {
    define: {
      // Workers Builds injects the commit being built; local builds get "local".
      "import.meta.env.COMMIT_SHA": JSON.stringify(process.env.WORKERS_CI_COMMIT_SHA ?? "local"),
    },
    plugins: [tailwindcss()],
  },
});
