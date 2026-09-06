import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro:content";

function docsId(entry: string) {
  const id = entry.replace(/\.(?:markdown|mdown|mkdn|mkd|mdwn|mdx?)$/, "");
  if (id === "index") {
    return "docs/index";
  }
  return id === "docs" || id.startsWith("docs/") ? id : `docs/${id}`;
}

export const collections = {
  docs: defineCollection({
    loader: docsLoader({ generateId: ({ entry }) => docsId(entry) }),
    schema: docsSchema(),
  }),
};
