import fs from "node:fs";
import path from "node:path";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const CONTENT_DOCS_DIR = path.join(APP_DIR, "src", "content", "docs");
const PUBLIC_DIR = path.join(APP_DIR, "public");
const PUBLIC_DOCS_DIR = path.join(PUBLIC_DIR, "docs");
const SITE = "https://x402-router.wgw.lol";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writePublicFile(rel, content) {
  const file = path.join(PUBLIC_DIR, rel);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, "utf8");
}

function markdownFiles(dir, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...markdownFiles(absolute, relative));
      continue;
    }
    if (/\.mdx?$/.test(entry.name)) {
      files.push(relative);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function routeForDoc(file) {
  const id = file.replace(/\.mdx?$/, "").replace(/\\/g, "/");
  return id === "index" ? "/docs/" : `/docs/${id}/`;
}

ensureDir(PUBLIC_DOCS_DIR);
fs.rmSync(PUBLIC_DOCS_DIR, { force: true, recursive: true });
ensureDir(PUBLIC_DOCS_DIR);

const docs = markdownFiles(CONTENT_DOCS_DIR);
for (const doc of docs) {
  const source = path.join(CONTENT_DOCS_DIR, doc);
  const target = path.join(PUBLIC_DOCS_DIR, doc.replace(/\.mdx$/, ".md"));
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
}

writePublicFile(
  "index.md",
  `# x402-router.wgw.lol

Standalone x402 v2 facilitator router for the normal x402 stack.

- One facilitator URL: \`${SITE}\`
- Endpoints: \`GET /supported\`, \`POST /verify\`, \`POST /settle\`, \`GET /health\`
- Ethereum Mainnet: PrimeV, 1.2s settlement, sponsored gas
- CDP-backed rails: short-lived pass-through JWT from the seller server
- License: FSL-1.1-ALv2, with Apache-2.0 future license after 2 years

Docs: ${SITE}/docs/
`,
);

writePublicFile(
  "llms.txt",
  `# x402-router.wgw.lol

> Standalone x402 v2 facilitator router for any Fetch API runtime.

## Docs

${docs.map((doc) => `- ${SITE}${routeForDoc(doc)} (${SITE}/docs/${doc.replace(/\.mdx$/, ".md")})`).join("\n")}

## API

- ${SITE}/supported
- ${SITE}/verify
- ${SITE}/settle
- ${SITE}/health
`,
);

writePublicFile(
  "robots.txt",
  `User-agent: *
Allow: /

Sitemap: ${SITE}/sitemap.xml

Content-Signal: search=yes, ai-input=yes, ai-train=yes
`,
);

writePublicFile(
  "sitemap.xml",
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}/</loc></url>
  ${docs.map((doc) => `<url><loc>${SITE}${routeForDoc(doc)}</loc></url>`).join("\n  ")}
</urlset>
`,
);
