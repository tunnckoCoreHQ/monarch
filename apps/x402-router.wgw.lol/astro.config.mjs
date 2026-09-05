import cloudflare from "@astrojs/cloudflare";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, sessionDrivers } from "astro/config";

const noAdapter = process.env.WGW_ASTRO_NO_ADAPTER === "1";

// https://astro.build/config
export default defineConfig({
  ...(noAdapter ? {} : { adapter: cloudflare() }),
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
    plugins: [tailwindcss()],
  },
});
