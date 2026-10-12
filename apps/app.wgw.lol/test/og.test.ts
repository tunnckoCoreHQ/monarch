import { beforeEach, describe, expect, it, vi } from "vitest";

import { app } from "../src/server/app";
import { findRepo, type RepoRow } from "../src/server/db";
import type { Env } from "../src/server/env";
import { cardHtml, cardKey, cardMeta, cardVersion, pageRepo } from "../src/server/og";
import { fakeD1 } from "./memory";

const ORIGIN = "https://app.wgw.lol";
const PUSHED_AT = 1_760_000_000;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** An in-memory R2 bucket with the two calls the card route makes. */
function fakeR2() {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  return {
    objects,
    get: async (key: string) => {
      const value = objects.get(key);
      return value === undefined ? null : { body: new Response(value).body };
    },
    put: async (key: string, value: Uint8Array<ArrayBuffer>) => {
      objects.set(key, value);
      return {};
    },
  };
}

let db: D1Database;
let bucket: ReturnType<typeof fakeR2>;
// Browser Rendering is not reachable here: every session request is turned away.
let browser: ReturnType<typeof vi.fn>;
let env: Env;

async function addRepo(name: string, visibility: "public" | "private"): Promise<RepoRow> {
  await db
    .prepare(
      "INSERT INTO repos (id, owner_id, name, description, visibility, pushed_at, created_at) VALUES (?, 'usr_alice', ?, ?, ?, ?, 0)",
    )
    .bind(`repo_${name}`, name, `<b>${name}</b> & co`, visibility, PUSHED_AT)
    .run();
  return (await findRepo(env, "alice", name)) as RepoRow;
}

function card(path: string) {
  return app.request(path, {}, env);
}

beforeEach(async () => {
  db = fakeD1();
  bucket = fakeR2();
  browser = vi.fn(async () => new Response("too many browsers", { status: 429 }));
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the fakes implement only the bindings og.ts calls.
  env = {
    ORIGIN,
    DB: db,
    GIT: bucket,
    BROWSER: { fetch: browser },
    REPO: {
      getByName: () => ({
        privacy: async () => ({ ok: true, value: { rules: "", hidden: false } }),
      }),
    },
  } as unknown as Env;
  await db
    .prepare(
      "INSERT INTO users (id, handle, name, kind, provider, subject, created_at) VALUES ('usr_alice', 'alice', 'Alice', 'human', 'google', 'alice', 0)",
    )
    .run();
});

describe("cardKey", () => {
  it("keys a card by repository, push time, and text", async () => {
    const repo = await addRepo("site", "public");
    expect(cardKey(repo)).toBe(`og/repo_site/${cardVersion(repo)}.png`);
    expect(cardVersion(repo).startsWith(`${PUSHED_AT}-`)).toBe(true);
    expect(cardVersion({ ...repo, pushed_at: null }).startsWith("0-")).toBe(true);
    // A description edit, without a push, still draws a new card.
    expect(cardKey({ ...repo, description: "edited" })).not.toBe(cardKey(repo));
    expect(cardKey({ ...repo })).toBe(cardKey(repo));
  });
});

describe("cardHtml", () => {
  it("escapes the repository fields and shows the branch and push date", async () => {
    const html = cardHtml(await addRepo("site", "public"), false);
    expect(html).toContain("&#60;b&#62;site&#60;/b&#62; &#38; co");
    expect(html).not.toContain("<b>site</b>");
    expect(html).toContain("main</span>");
    expect(html).toContain("Oct 9, 2025");
    expect(html).not.toContain("public paths only");
  });

  it("notes public paths only when .gitprivate has rules", async () => {
    expect(cardHtml(await addRepo("site", "public"), true)).toContain("public paths only");
  });
});

describe("cardMeta", () => {
  it("points og:image at the card for the current push", async () => {
    const repo = await addRepo("site", "public");
    expect(cardMeta(repo, ORIGIN)).toEqual({
      "og:title": "alice/site",
      "og:description": "<b>site</b> & co",
      "og:image": `${ORIGIN}/og/alice/site.png?v=${cardVersion(repo)}`,
    });
    expect(cardMeta({ ...repo, description: "" }, ORIGIN)["og:description"]).toBe(
      "alice/site on wgw, git hosting on Cloudflare.",
    );
  });
});

describe("pageRepo", () => {
  it("finds the public repository of a page and the pages under it", async () => {
    await addRepo("site", "public");
    expect((await pageRepo(env, "/alice/site"))?.id).toBe("repo_site");
    expect((await pageRepo(env, "/Alice/site/commits"))?.id).toBe("repo_site");
  });

  it("finds nothing for private, unknown, and non-repository pages", async () => {
    await addRepo("secret", "private");
    for (const path of ["/alice/secret", "/alice/missing", "/alice", "/", "/login/passkey"]) {
      expect(await pageRepo(env, path)).toBeNull();
    }
  });
});

describe("GET /og/:owner/:name.png", () => {
  it("returns 404 for private and unknown repositories, even with a stored card", async () => {
    const secret = await addRepo("secret", "private");
    bucket.objects.set(cardKey(secret), PNG);
    expect((await card("/og/alice/secret.png")).status).toBe(404);
    expect((await card("/og/alice/missing.png")).status).toBe(404);
    expect(browser).not.toHaveBeenCalled();
  });

  it("serves the stored card for the current push without a browser", async () => {
    bucket.objects.set(cardKey(await addRepo("site", "public")), PNG);
    const response = await card(`/og/alice/site.png?v=${PUSHED_AT}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("max-age=31536000");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect(browser).not.toHaveBeenCalled();
  });

  it("redirects to the static card when Browser Rendering fails", async () => {
    await addRepo("site", "public");
    const response = await card("/og/alice/site.png");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/og.png`);
    expect(browser).toHaveBeenCalledOnce();
    expect(bucket.objects.size).toBe(0);
  });
});
