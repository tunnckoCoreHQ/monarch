import { afterPush } from "./api";
import { findRepoById } from "./db";
import type { Env } from "./env";

const API = "https://api.cloudflare.com/client/v4";

interface ApiResult<T> {
  success: boolean;
  result: T;
  errors: Array<{ code: number; message: string }>;
}

async function eventsApi<T>(env: Env, path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${API}/accounts/${env.ACCOUNT_ID}/event_subscriptions${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${await env.EVENTS_TOKEN.get()}`,
      "content-type": "application/json",
    },
  });
  const data: ApiResult<T> = await res.json();
  if (!res.ok || !data.success) {
    const reason = data.errors.map((error) => error.message).join("; ") || res.statusText;
    throw new Error(`event subscriptions API answered ${res.status}: ${reason}`);
  }
  return data.result;
}

/**
 * Subscribes the events queue to pushes on one Artifacts repo. A push made with a direct
 * Artifacts token then reaches the mirror within seconds, not on the next page view.
 */
export async function subscribePushes(env: Env, artifactsName: string): Promise<string> {
  const created = await eventsApi<{ id: string }>(env, "/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      name: `app.wgw.lol push ${artifactsName}`,
      enabled: true,
      source: {
        type: "artifacts.repo",
        namespace: env.ARTIFACTS_NAMESPACE,
        repo_name: artifactsName,
      },
      destination: { type: "queues.queue", queue_id: env.EVENTS_QUEUE_ID },
      events: ["pushed"],
    }),
  });
  return created.id;
}

export async function unsubscribe(env: Env, id: string): Promise<void> {
  await eventsApi(env, `/subscriptions/${id}`, { method: "DELETE" });
}

interface ArtifactsEvent {
  type: string;
  source: { type: string; namespace: string; repoName: string };
  payload: { repoName?: string; ref?: string };
}

function isArtifactsEvent(body: unknown): body is ArtifactsEvent {
  if (typeof body !== "object" || body === null || !("type" in body) || !("source" in body)) {
    return false;
  }
  const { source } = body;
  return (
    typeof body.type === "string" &&
    typeof source === "object" &&
    source !== null &&
    "repoName" in source &&
    typeof source.repoName === "string"
  );
}

/** Handles one Artifacts event. Events for other namespaces and for public repos are ignored. */
async function handle(env: Env, event: ArtifactsEvent): Promise<void> {
  if (event.source.namespace !== env.ARTIFACTS_NAMESPACE) {
    return;
  }
  // A fork names its new repo in the payload; every other event names its repo in the source.
  const name =
    event.type === "cf.artifacts.repo.forked"
      ? (event.payload.repoName ?? "")
      : event.source.repoName;
  if (name.endsWith(".public")) {
    return;
  }
  const repo = await findRepoById(env, name);
  if (repo === null) {
    return;
  }
  if (event.type === "cf.artifacts.repo.deleted") {
    // Deleted outside the app, for example from the dashboard; the record must say so.
    await env.DB.prepare("UPDATE repos SET status = 'failed', status_detail = ? WHERE id = ?")
      .bind("the Artifacts repository was deleted outside app.wgw.lol", repo.id)
      .run();
    return;
  }
  if (repo.status !== "ready") {
    // Imports and forks still running belong to the RepoReady workflow.
    return;
  }
  const synced = await env.REPO.getByName(repo.id).sync();
  if (!synced.ok) {
    throw new Error(synced.error);
  }
  await afterPush(env, repo, null, synced.value.updates);
}

/** The queue consumer: syncs the mirror on Artifacts pushes, and records deletions. */
export async function handleEvents(batch: MessageBatch, env: Env): Promise<void> {
  for (const message of batch.messages) {
    if (!isArtifactsEvent(message.body)) {
      message.ack();
      continue;
    }
    try {
      await handle(env, message.body);
      message.ack();
    } catch (error) {
      console.error(`Artifacts event ${message.body.type} failed`, error);
      message.retry({ delaySeconds: 10 });
    }
  }
}
