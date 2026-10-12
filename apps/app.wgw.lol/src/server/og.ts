import { launch } from "@cloudflare/puppeteer";
import archivo from "@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2?inline";
import jetbrainsMono from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?inline";
import { Hono } from "hono";

import { escapeHtml } from "../lib/utils";
import { repoStub, unwrap } from "./api";
import type { AppEnv } from "./auth";
import { findRepo, RESERVED, type RepoRow } from "./db";
import type { Env } from "./env";
import { HttpError, isName } from "./util";

// Social preview cards. A public repository page links /og/:owner/:name.png as its og:image, and
// that route draws the card with Browser Rendering once per push and keeps the PNG in R2.

const WIDTH = 1200;
const HEIGHT = 630;
/** The static card in public/. It is the site-wide og:image and the card when rendering fails. */
const FALLBACK = "/og.png";
const PUSHED = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

// The colors and fonts of src/styles.css. The fonts are inlined, so the page makes no requests.
const CARD_CSS = `
@font-face { font-family: "Archivo"; src: url("${archivo}") format("woff2"); font-weight: 100 900; }
@font-face { font-family: "JetBrains Mono"; src: url("${jetbrainsMono}") format("woff2"); font-weight: 100 800; }
* { box-sizing: border-box; margin: 0; }
body {
  display: flex;
  flex-direction: column;
  width: ${WIDTH}px;
  height: ${HEIGHT}px;
  padding: 64px 72px 0;
  overflow: hidden;
  border-bottom: 16px solid oklch(0.91 0.21 124);
  background: oklch(0.09 0 0);
  color: oklch(0.96 0 0);
  font-family: "Archivo", sans-serif;
  font-feature-settings: "ss01";
}
.mono { font-family: "JetBrains Mono", monospace; }
.muted { color: oklch(0.68 0.01 120); }
header { display: flex; align-items: center; gap: 16px; font-size: 22px; }
.mark { width: 24px; height: 24px; background: oklch(0.91 0.21 124); }
.word { font-size: 40px; font-weight: 900; letter-spacing: -0.05em; line-height: 1; }
.host { margin-left: auto; font-size: 24px; }
main { margin-top: auto; }
.owner { font-size: 32px; }
h1 { margin-top: 8px; font-weight: 900; letter-spacing: -0.03em; line-height: 1; }
.description { margin-top: 20px; font-size: 32px; line-height: 1.3; }
h1, .description {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
footer {
  display: flex;
  align-items: center;
  gap: 48px;
  margin-top: 40px;
  padding: 28px 0 36px;
  border-top: 2px solid oklch(0.27 0.006 120);
  font-size: 22px;
  white-space: nowrap;
}
.item { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.label, .note { letter-spacing: 0.1em; text-transform: uppercase; }
.label { margin-right: 12px; color: oklch(0.68 0.01 120); }
.note {
  flex-shrink: 0;
  margin-left: auto;
  padding: 6px 14px;
  border: 2px solid oklch(0.91 0.21 124);
  color: oklch(0.91 0.21 124);
}
`;

/**
 * Names the card's content: the push time plus a hash of the description and default branch, so a
 * push or a settings edit draws a new card and gives the page a new og:image URL.
 */
export function cardVersion(repo: RepoRow): string {
  // FNV-1a; the key only has to change when the text does.
  let hash = 0x81_1c_9d_c5;
  for (const char of `${repo.description}\0${repo.default_branch}`) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01_00_01_93) >>> 0;
  }
  return `${repo.pushed_at ?? 0}-${hash.toString(36)}`;
}

export function cardKey(repo: RepoRow): string {
  return `og/${repo.id}/${cardVersion(repo)}.png`;
}

/** The card shows what the repository page shows everyone, plus whether `.gitprivate` has rules. */
export function cardHtml(repo: RepoRow, hasRules: boolean): string {
  const pushed = repo.pushed_at === null ? "never" : PUSHED.format(repo.pushed_at * 1000);
  const description =
    repo.description === ""
      ? ""
      : `<p class="muted description">${escapeHtml(repo.description)}</p>`;
  const note = hasRules ? `<span class="note">public paths only</span>` : "";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><style>${CARD_CSS}</style></head>
<body>
  <header>
    <span class="mark"></span>
    <span class="word">wgw</span>
    <span class="mono muted">/git</span>
    <span class="mono muted host">app.wgw.lol</span>
  </header>
  <main>
    <p class="mono muted owner">${escapeHtml(repo.owner)} /</p>
    <h1 style="font-size: ${repo.name.length > 16 ? 72 : 112}px">${escapeHtml(repo.name)}</h1>
    ${description}
  </main>
  <footer class="mono">
    <span class="item"><span class="label">branch</span>${escapeHtml(repo.default_branch)}</span>
    <span class="item"><span class="label">pushed</span>${pushed}</span>
    ${note}
  </footer>
</body>
</html>`;
}

/** The Open Graph values of a public repository page, keyed by property. */
export function cardMeta(repo: RepoRow, origin: string): Record<string, string> {
  const title = `${repo.owner}/${repo.name}`;
  return {
    "og:title": title,
    "og:description":
      repo.description === "" ? `${title} on wgw, git hosting on Cloudflare.` : repo.description,
    // The version in the URL makes crawlers fetch the new card after a push or an edit.
    "og:image": `${origin}/og/${repo.owner}/${repo.name}.png?v=${cardVersion(repo)}`,
  };
}

/** The public repository of a web page: `/:owner/:name` and the pages under it. */
export async function pageRepo(env: Env, pathname: string): Promise<RepoRow | null> {
  const [, owner = "", name = ""] = pathname.split("/");
  if (RESERVED.has(owner.toLowerCase()) || !isName(name)) {
    return null;
  }
  const repo = await findRepo(env, owner, name);
  return repo?.visibility === "public" ? repo : null;
}

/**
 * Points the shell's Open Graph tags at the repository card. The root route renders the
 * site-wide tags, and crawlers do not run the app, so the Worker rewrites their values.
 */
export async function withRepoCard(
  env: Env,
  pathname: string,
  page: Response | Promise<Response>,
): Promise<Response> {
  const [response, repo] = await Promise.all([
    page,
    // The page must load even when the lookup fails; it keeps the site-wide tags.
    pageRepo(env, pathname).catch((error: unknown) => {
      console.error(error);
      return null;
    }),
  ]);
  if (repo === null || !response.headers.get("content-type")?.startsWith("text/html")) {
    return response;
  }

  const rewriter = new HTMLRewriter();
  for (const [property, content] of Object.entries(cardMeta(repo, env.ORIGIN))) {
    rewriter.on(`meta[property="${property}"]`, {
      element(element) {
        // lol-html escapes the quotes only, so a literal & would start an entity.
        element.setAttribute("content", content.replaceAll("&", "&amp;"));
      },
    });
  }
  return rewriter.transform(response);
}

function png(body: BodyInit): Response {
  return new Response(body, {
    headers: {
      "content-type": "image/png",
      // The page links the card with its push time, so a new push gets a new URL.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

/** Draws the card in one Browser Rendering session, and closes the session. */
async function screenshot(env: Env, html: string): Promise<Uint8Array<ArrayBuffer>> {
  const browser = await launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluateHandle("document.fonts.ready");
    return new Uint8Array(await page.screenshot({ type: "png" }));
  } finally {
    await browser.close();
  }
}

export const og = new Hono<AppEnv>();

og.get("/og/:owner/:file{.+\\.png}", async (c) => {
  const repo = await findRepo(c.env, c.req.param("owner"), c.req.param("file").slice(0, -4));
  // Private repositories look missing, as they do everywhere else.
  if (repo === null || repo.visibility !== "public") {
    throw new HttpError(404, "repository not found", "not_found");
  }

  const key = cardKey(repo);
  const cached = await c.env.GIT.get(key);
  if (cached !== null) {
    return png(cached.body);
  }

  try {
    const privacy = unwrap(await repoStub(c.env, repo.id).privacy(repo.default_branch));
    const image = await screenshot(c.env, cardHtml(repo, privacy.rules !== ""));
    await c.env.GIT.put(key, image, { httpMetadata: { contentType: "image/png" } });
    // A delete that ran while the card was drawn already cleared the card prefix; drop this one.
    const still = await findRepo(c.env, repo.owner, repo.name);
    if (still?.id !== repo.id) {
      await c.env.GIT.delete(key);
      throw new HttpError(404, "repository not found", "not_found");
    }
    return png(image);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    // A crawler gets the static card now and retries the real one on its next fetch.
    console.error(error);
    return c.redirect(`${c.env.ORIGIN}${FALLBACK}`, 302);
  }
});
