import { openSecret } from "./crypto";
import type { RepoRow } from "./db";
import type { Env } from "./env";
import { HttpError, now } from "./util";

export const WEBHOOK_EVENTS = ["push", "pull_request", "pull_request_comment", "repository"];

// Deliveries kept per webhook; the oldest go first.
const KEEP_DELIVERIES = 50;
const TIMEOUT_MS = 10_000;
// Queue retries wait 30, 60, then 120 seconds; the consumer trigger stops after 3.
const RETRY_BASE_SECONDS = 30;
// The queue consumer has maxRetries: 3, so the fourth attempt is the last one.
const MAX_ATTEMPTS = 3;

const encoder = new TextEncoder();
// A queue message holds at most 128 KiB. Larger bodies wait in R2 and the message names them.
const INLINE_BODY_BYTES = 64 * 1024;
const BODY_PREFIX = "webhooks/";

/** One delivery to one webhook. The body is signed when it is queued, so the consumer needs no key. */
export interface WebhookMessage {
  type: "wgw.webhook";
  hookId: string;
  url: string;
  event: string;
  delivery: string;
  /** The body, or "" when it was too large for a queue message and `bodyKey` names it in R2. */
  body: string;
  bodyKey?: string;
  signature: string;
  /** Queued while the repository is deleted, which deletes the webhook row before delivery. */
  repoDeleted: boolean;
}

export function isWebhookMessage(body: unknown): body is WebhookMessage {
  return (
    typeof body === "object" &&
    body !== null &&
    "type" in body &&
    body.type === "wgw.webhook" &&
    "hookId" in body &&
    typeof body.hookId === "string" &&
    "url" in body &&
    typeof body.url === "string" &&
    "body" in body &&
    typeof body.body === "string"
  );
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A new signing secret: 32 random bytes as hex. */
export function newHookSecret(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

/** The `X-WGW-Signature-256` header: `sha256=` and the hex HMAC-SHA256 of the body. */
export async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `sha256=${hex(await crypto.subtle.sign("HMAC", key, encoder.encode(body)))}`;
}

/** The associated data of a webhook's sealed secret. */
export function hookSecretContext(repoId: string, hookId: string): string {
  return `${repoId}:webhook:${hookId}`;
}

/** Loopback, private, link-local, shared, and reserved addresses, as the URL parser writes them. */
function isPrivateAddress(host: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    // "::" starts the unspecified, loopback, IPv4-compatible, and IPv4-mapped addresses.
    return v6.startsWith("::") || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
  }
  return false;
}

/**
 * A webhook URL: https, and not this app, localhost, or a private address. A hostname that
 * resolves to a private address still fails at delivery: Workers fetch reaches only public hosts.
 */
export function hookUrl(value: string, origin: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "url is not a URL", "invalid_request");
  }
  if (url.protocol !== "https:") {
    throw new HttpError(400, "url must start with https://", "invalid_request");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === new URL(origin).hostname ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    isPrivateAddress(host)
  ) {
    throw new HttpError(
      400,
      "url must point at a public host, not app.wgw.lol, localhost, or a private address",
      "invalid_request",
    );
  }
  return url.toString();
}

/** The event names of a webhook: known names, at least one, each once. */
export function hookEvents(value: unknown[]): string[] {
  const unique = [...new Set(value)];
  const events = unique.filter(
    (event): event is string => typeof event === "string" && WEBHOOK_EVENTS.includes(event),
  );
  if (events.length === 0 || events.length !== unique.length) {
    throw new HttpError(
      400,
      `events must be a list of ${WEBHOOK_EVENTS.join(", ")}`,
      "invalid_request",
    );
  }
  return events;
}

/** The fields of one event, before the repository, sender, and delivery id are added. */
export type Payload = Record<string, unknown>;

export interface Sender {
  handle: string;
}

/** The JSON body of a delivery: the event's fields, then the repository, sender, and delivery id. */
export function hookBody(
  repo: RepoRow,
  sender: Sender | null,
  delivery: string,
  payload: Payload,
): string {
  return JSON.stringify({
    ...payload,
    repository: { owner: repo.owner, name: repo.name, visibility: repo.visibility },
    ...(sender === null ? {} : { sender }),
    delivery,
  });
}

/**
 * Queues one delivery per payload to each active webhook of the repository that takes the event.
 * `payloads` gets the sender, the account of `actorId`, or null. Best effort: a failure is logged,
 * never thrown, so it cannot fail the push or request that caused the event.
 */
export async function sendWebhooks(
  env: Env,
  repo: RepoRow,
  event: string,
  actorId: string | null,
  payloads: (sender: Sender | null) => Payload[],
  repoDeleted = false,
): Promise<void> {
  try {
    const hooks = await env.DB.prepare(
      "SELECT webhooks.id, webhooks.url, webhooks.secret, (SELECT handle FROM users WHERE id = ?) AS sender FROM webhooks WHERE repo_id = ? AND active = 1 AND EXISTS (SELECT 1 FROM json_each(webhooks.events) WHERE value = ?)",
    )
      .bind(actorId, repo.id, event)
      .all<{ id: string; url: string; secret: string; sender: string | null }>();
    const messages: WebhookMessage[] = [];
    for (const hook of hooks.results) {
      const secret = await openSecret(
        env,
        repo.id,
        hookSecretContext(repo.id, hook.id),
        hook.secret,
      );
      const sender = hook.sender === null ? null : { handle: hook.sender };
      for (const payload of payloads(sender)) {
        const delivery = crypto.randomUUID();
        const body = hookBody(repo, sender, delivery, payload);
        const signature = await signBody(secret, body);
        let bodyKey: string | undefined;
        if (encoder.encode(body).length > INLINE_BODY_BYTES) {
          bodyKey = `${BODY_PREFIX}${delivery}.json`;
          await env.GIT.put(bodyKey, body, { httpMetadata: { contentType: "application/json" } });
        }
        messages.push({
          type: "wgw.webhook",
          hookId: hook.id,
          url: hook.url,
          event,
          delivery,
          body: bodyKey === undefined ? body : "",
          bodyKey,
          signature,
          repoDeleted,
        });
      }
    }
    await Promise.all(messages.map((message) => env.EVENTS.send(message)));
  } catch (error) {
    console.error(`could not queue ${event} webhooks for ${repo.id}`, error);
  }
}

/** One `push` delivery per ref update. */
export function sendPushHooks(
  env: Env,
  repo: RepoRow,
  actorId: string | null,
  updates: Array<{ ref: string; old: string; new: string }>,
): Promise<void> {
  return sendWebhooks(env, repo, "push", actorId, (sender) =>
    updates.map((update) => ({
      ref: update.ref,
      before: update.old,
      after: update.new,
      pusher: sender,
    })),
  );
}

export interface Delivery {
  id: string;
  event: string;
  status: number | null;
  error: string | null;
  duration_ms: number;
  created_at: number;
}

/**
 * POSTs one delivery and records it. A retry of a delivery updates its row. Redirects are not
 * followed. The record is best effort: a delivery that landed is not sent again over it.
 */
export async function deliver(
  env: Env,
  message: Omit<WebhookMessage, "type" | "repoDeleted">,
): Promise<Delivery> {
  const started = Date.now();
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(message.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "user-agent": "app.wgw.lol-webhooks",
        "x-wgw-event": message.event,
        "x-wgw-delivery": message.delivery,
        "x-wgw-signature-256": message.signature,
      },
      body: message.body,
    });
    status = res.status;
    await res.body?.cancel();
  } catch (caught) {
    error =
      caught instanceof Error && caught.name === "TimeoutError"
        ? `no response in ${TIMEOUT_MS / 1000} s`
        : caught instanceof Error
          ? caught.message
          : String(caught);
  }
  const delivery: Delivery = {
    id: message.delivery,
    event: message.event,
    status,
    error,
    duration_ms: Date.now() - started,
    created_at: now(),
  };
  try {
    await env.DB.batch([
      // Nothing is recorded for a webhook that is gone.
      env.DB.prepare(
        "INSERT INTO webhook_deliveries (id, webhook_id, event, status, error, duration_ms, created_at) SELECT ?, id, ?, ?, ?, ?, ? FROM webhooks WHERE id = ? ON CONFLICT (id) DO UPDATE SET status = excluded.status, error = excluded.error, duration_ms = excluded.duration_ms, created_at = excluded.created_at",
      ).bind(
        delivery.id,
        delivery.event,
        status,
        error,
        delivery.duration_ms,
        delivery.created_at,
        message.hookId,
      ),
      env.DB.prepare("UPDATE webhooks SET last_status = ?, last_delivery_at = ? WHERE id = ?").bind(
        status,
        delivery.created_at,
        message.hookId,
      ),
      env.DB.prepare(
        "DELETE FROM webhook_deliveries WHERE webhook_id = ?1 AND id NOT IN (SELECT id FROM webhook_deliveries WHERE webhook_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2)",
      ).bind(message.hookId, KEEP_DELIVERIES),
    ]);
  } catch (caught) {
    console.error(`could not record webhook delivery ${delivery.id}`, caught);
  }
  return delivery;
}

/**
 * The queue consumer's part: delivers unless the webhook was paused or deleted since. A 5xx or no
 * response goes back to the queue with a growing delay; any other status is final.
 */
export async function handleWebhook(
  env: Env,
  body: WebhookMessage,
  message: Message,
): Promise<void> {
  const done = async () => {
    message.ack();
    if (body.bodyKey !== undefined) {
      await env.GIT.delete(body.bodyKey);
    }
  };
  const hook = await env.DB.prepare("SELECT active FROM webhooks WHERE id = ?")
    .bind(body.hookId)
    .first<{ active: number }>();
  if (hook === null ? !body.repoDeleted : hook.active !== 1) {
    await done();
    return;
  }
  let text = body.body;
  if (body.bodyKey !== undefined) {
    const stored = await env.GIT.get(body.bodyKey);
    if (stored === null) {
      console.error(`webhook body ${body.bodyKey} is gone; delivery ${body.delivery} dropped`);
      message.ack();
      return;
    }
    text = await stored.text();
  }
  const delivery = await deliver(env, { ...body, body: text });
  const retry = delivery.status === null || delivery.status >= 500;
  // On the last attempt the body in R2 goes too, whatever the result.
  if (retry && message.attempts <= MAX_ATTEMPTS) {
    message.retry({ delaySeconds: RETRY_BASE_SECONDS * 2 ** (message.attempts - 1) });
  } else {
    await done();
  }
}

/** Sends a `ping` now, outside the queue, so the caller sees the result. */
export async function pingHook(
  env: Env,
  repo: RepoRow,
  hook: { id: string; url: string; events: string; secret: string },
  sender: Sender,
): Promise<Delivery> {
  const delivery = crypto.randomUUID();
  const body = hookBody(repo, sender, delivery, {
    hook: { id: hook.id, url: hook.url, events: JSON.parse(hook.events) },
  });
  const secret = await openSecret(env, repo.id, hookSecretContext(repo.id, hook.id), hook.secret);
  return deliver(env, {
    hookId: hook.id,
    url: hook.url,
    event: "ping",
    delivery,
    body,
    signature: await signBody(secret, body),
  });
}
