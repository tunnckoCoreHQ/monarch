import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { recordEvent } from "./db";
import type { Env } from "./env";
import { now } from "./util";

export interface ReadyParams {
  repoId: string;
  actorId: string | null;
  kind: "import" | "fork";
  source: string;
}

// An import or fork that is still running after this many checks is marked failed.
const CHECKS = 60;

/** Waits until an Artifacts import or fork has finished, syncs the mirror, and marks the repo ready. */
export class RepoReady extends WorkflowEntrypoint<Env, ReadyParams> {
  override async run(event: Readonly<WorkflowEvent<ReadyParams>>, step: WorkflowStep) {
    const { repoId, kind } = event.payload;
    try {
      return await this.wait(event.payload, step);
    } catch (error) {
      // A step that keeps failing ends the workflow; the repo must not stay "importing" forever.
      const reason = error instanceof Error ? error.message : String(error);
      await step.do("mark failed", async () => {
        await this.env.DB.prepare(
          "UPDATE repos SET status = 'failed', status_detail = ? WHERE id = ?",
        )
          .bind(`the ${kind} failed: ${reason}`.slice(0, 500), repoId)
          .run();
      });
      return { ready: false };
    }
  }

  private async wait(params: ReadyParams, step: WorkflowStep) {
    const { repoId, actorId, kind, source } = params;
    const stub = this.env.REPO.getByName(repoId);
    let ready = false;
    for (let check = 0; check < CHECKS && !ready; check++) {
      ready = await step.do(`check ${check}`, async () => {
        const result = await stub.isReady();
        if (!result.ok) {
          throw new Error(result.error);
        }
        return result.value;
      });
      if (!ready) {
        await step.sleep(`wait ${check}`, "5 seconds");
      }
    }
    if (!ready) {
      throw new Error("it did not finish in time");
    }
    const synced = await step.do(
      "sync",
      { retries: { limit: 3, delay: "5 seconds", backoff: "linear" } },
      async () => {
        const result = await stub.sync();
        if (!result.ok) {
          throw new Error(result.error);
        }
        return { refs: result.value.updates.length, publishError: result.value.publishError };
      },
    );
    await step.do("mark ready", async () => {
      const head = await stub.head();
      const branch = head.ok ? head.value.replace(/^refs\/heads\//, "") : "main";
      // Members can use the repo even when the public view could not be published yet.
      const detail =
        synced.publishError === null ? null : `public view not published: ${synced.publishError}`;
      await this.env.DB.prepare(
        "UPDATE repos SET status = 'ready', status_detail = ?, default_branch = ?, pushed_at = ? WHERE id = ?",
      )
        .bind(detail, branch, now(), repoId)
        .run();
      await recordEvent(this.env, repoId, actorId, kind, { source, refs: synced.refs });
    });
    return { ready: true, refs: synced.refs };
  }
}
