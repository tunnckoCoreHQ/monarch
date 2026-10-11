import type { Env } from "./env";
import { enqueueIndex } from "./search";
import { now } from "./util";

/**
 * Hourly upkeep. Subscribes every ready repository that has no push subscription yet: one made
 * before push events existed, or one whose subscription failed. Queues a search index for pushed
 * repositories that have none. Then deletes sign-in rows that can no longer be used.
 */
export async function handleCron(_controller: ScheduledController, env: Env): Promise<void> {
  const repos = await env.DB.prepare("SELECT id FROM repos WHERE status = 'ready'").all<{
    id: string;
  }>();
  for (const { id } of repos.results) {
    const checked = await env.REPO.getByName(id).checkSubscription();
    if (!checked.ok) {
      console.error(`subscription check failed for ${id}: ${checked.error}`);
    }
  }
  const unindexed = await env.DB.prepare(
    "SELECT id FROM repos WHERE status = 'ready' AND pushed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM search_files WHERE search_files.repo_id = repos.id)",
  ).all<{ id: string }>();
  for (const { id } of unindexed.results) {
    await enqueueIndex(env, id);
  }
  const at = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(at),
    env.DB.prepare("DELETE FROM device_codes WHERE expires_at < ?").bind(at - 86_400),
    env.DB.prepare("DELETE FROM tokens WHERE kind = 'agent' AND expires_at < ?").bind(at),
  ]);
}
