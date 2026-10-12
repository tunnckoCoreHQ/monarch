import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/server/env";
import { handleEvents } from "../src/server/events";
import { hookUrl, signBody, type WebhookMessage } from "../src/server/webhooks";
import { fakeD1 } from "./memory";

const ORIGIN = "https://app.wgw.lol";

let env: Env;

beforeEach(async () => {
  const db = fakeD1();
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the consumer reaches only D1.
  env = { DB: db } as unknown as Env;
  await db
    .prepare(
      "INSERT INTO users (id, handle, name, kind, provider, subject, created_at) VALUES ('usr_alice', 'alice', 'Alice', 'human', 'google', 'alice', 0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO repos (id, owner_id, name, visibility, created_at) VALUES ('repo_pub', 'usr_alice', 'pub', 'public', 0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO webhooks (id, repo_id, url, events, secret, active, created_at) VALUES ('hook_1', 'repo_pub', 'https://hooks.example.com/wgw', '[\"push\"]', 'sealed', 1, 0)",
    )
    .run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function webhookMessage(overrides: Partial<WebhookMessage> = {}): WebhookMessage {
  return {
    type: "wgw.webhook",
    hookId: "hook_1",
    url: "https://hooks.example.com/wgw",
    event: "push",
    delivery: "dlv-1",
    body: '{"ref":"refs/heads/main"}',
    signature: "sha256=abc",
    repoDeleted: false,
    ...overrides,
  };
}

/** Runs the consumer on one message and returns what it did with it. */
async function consume(body: WebhookMessage, attempts = 1) {
  const message = { body, attempts, ack: vi.fn(), retry: vi.fn() };
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the consumer reads only these fields.
  await handleEvents({ messages: [message] } as unknown as MessageBatch, env);
  return message;
}

function answer(status: number) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function deliveries() {
  const rows = await env.DB.prepare(
    "SELECT id, status, error FROM webhook_deliveries ORDER BY created_at, rowid",
  ).all<{ id: string; status: number | null; error: string | null }>();
  return rows.results;
}

describe("signBody", () => {
  it("is the hex HMAC-SHA256 of the body, as node:crypto computes it", async () => {
    const body = JSON.stringify({ ref: "refs/heads/main", delivery: "d" });
    expect(await signBody("s3cret", body)).toBe(
      `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`,
    );
  });
});

describe("hookUrl", () => {
  it("accepts public https URLs", () => {
    expect(hookUrl("https://hooks.example.com/wgw?x=1", ORIGIN)).toBe(
      "https://hooks.example.com/wgw?x=1",
    );
    expect(hookUrl("https://8.8.8.8/hook", ORIGIN)).toBe("https://8.8.8.8/hook");
    expect(hookUrl("https://other.wgw.lol/hook", ORIGIN)).toBe("https://other.wgw.lol/hook");
  });

  it("refuses http, localhost, this app, and private addresses", () => {
    for (const url of [
      "http://hooks.example.com/wgw",
      "ftp://hooks.example.com/wgw",
      "https://localhost/hook",
      "https://api.localhost/hook",
      "https://LOCALHOST./hook",
      "https://app.wgw.lol/api/me",
      "https://APP.WGW.LOL./api/me",
      "https://127.0.0.1/hook",
      "https://2130706433/hook",
      "https://0.0.0.0/hook",
      "https://10.1.2.3/hook",
      "https://100.64.0.1/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://172.16.0.1/hook",
      "https://172.31.255.255/hook",
      "https://192.168.0.10/hook",
      "https://[::1]/hook",
      "https://[::]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://[fd00::1]/hook",
      "https://[fe80::1]/hook",
      "not a url",
    ]) {
      expect(() => hookUrl(url, ORIGIN), url).toThrow();
    }
  });
});

describe("the webhook consumer", () => {
  it("POSTs the signed body with the event headers and records the delivery", async () => {
    const fetch = answer(204);
    const message = await consume(webhookMessage());
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/wgw");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.body).toBe('{"ref":"refs/heads/main"}');
    expect(init.headers).toMatchObject({
      "x-wgw-event": "push",
      "x-wgw-delivery": "dlv-1",
      "x-wgw-signature-256": "sha256=abc",
    });
    expect(await deliveries()).toEqual([{ id: "dlv-1", status: 204, error: null }]);
    const hook = await env.DB.prepare("SELECT last_status FROM webhooks").first();
    expect(hook).toEqual({ last_status: 204 });
  });

  it("retries a 5xx or no response with a growing delay, and records each attempt once", async () => {
    answer(503);
    expect((await consume(webhookMessage(), 1)).retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect((await consume(webhookMessage(), 2)).retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const failed = await consume(webhookMessage(), 3);
    expect(failed.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(failed.ack).not.toHaveBeenCalled();
    expect(await deliveries()).toEqual([{ id: "dlv-1", status: null, error: "fetch failed" }]);
  });

  it("does not retry a 4xx or a redirect", async () => {
    for (const status of [400, 404, 410, 302]) {
      answer(status);
      const message = await consume(webhookMessage({ delivery: `dlv-${status}` }));
      expect(message.ack, String(status)).toHaveBeenCalled();
      expect(message.retry, String(status)).not.toHaveBeenCalled();
    }
  });

  it("skips paused and deleted webhooks, except for the repository's deletion", async () => {
    const fetch = answer(200);
    await env.DB.prepare("UPDATE webhooks SET active = 0").run();
    expect((await consume(webhookMessage())).ack).toHaveBeenCalled();
    await env.DB.prepare("DELETE FROM repos").run();
    expect((await consume(webhookMessage())).ack).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    const deleted = await consume(webhookMessage({ event: "repository", repoDeleted: true }));
    expect(deleted.ack).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    // The webhook went with the repository, so there is nothing to record against.
    expect(await deliveries()).toEqual([]);
  });

  it("keeps the last 50 deliveries per webhook", async () => {
    for (let i = 0; i < 55; i++) {
      await env.DB.prepare(
        "INSERT INTO webhook_deliveries (id, webhook_id, event, status, duration_ms, created_at) VALUES (?, 'hook_1', 'push', 200, 1, ?)",
      )
        .bind(`old-${i}`, i)
        .run();
    }
    answer(200);
    await consume(webhookMessage({ delivery: "newest" }));
    const kept = await deliveries();
    expect(kept).toHaveLength(50);
    expect(kept.at(-1)?.id).toBe("newest");
    expect(kept[0].id).toBe("old-6");
  });
});
