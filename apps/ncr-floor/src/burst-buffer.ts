import { LifecycleCapability, type LifecycleJobContext } from "agents/lifecycle";

import { type Bubble, burstOperationId, joinBurst } from "./burst";

const JOB_ID = "burst";

type BurstBufferOptions = {
  readonly delayMs: number;
  /** Hands one closed burst to Pi. It runs again after an eviction, so it must dedupe on `operationId`. */
  readonly flush: (input: string, operationId: string) => Promise<unknown>;
};

/**
 * NCR's idle buffer. Bubbles wait in this object's SQLite, without a model call, until
 * the user goes quiet for `delayMs`: no new bubble and no typing signal. Then they go to
 * Pi as one turn.
 *
 * The quiet timer is a Lifecycle job, never `ctx.storage.setAlarm()`. A Durable Object
 * has one alarm, and the Agents SDK Lifecycle owns it: after every queue change it arms
 * the alarm for the earliest job, and that queue also holds PiHarness's per-session
 * wake-up jobs. Setting the alarm directly would move Pi's wake-up, and Lifecycle's next
 * re-arm would silently move ours. Job ids are scoped to their owning capability, so ours
 * cannot replace Pi's. Pushing again under the same id replaces our pending job, and that
 * is the reset.
 */
export class BurstBuffer extends LifecycleCapability {
  readonly #options: BurstBufferOptions;

  constructor(options: BurstBufferOptions) {
    super("ncr-burst");
    this.#options = options;
  }

  override onStart(): void {
    this.lifecycle.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS ncr_burst (seq INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, at INTEGER NOT NULL)",
    );
  }

  /** How many bubbles the open burst holds. */
  size(): number {
    return this.lifecycle.storage.sql
      .exec<{ count: number }>("SELECT count(*) AS count FROM ncr_burst")
      .one().count;
  }

  /** Adds a bubble and restarts the quiet timer. Returns the burst's size. */
  async append(text: string): Promise<number> {
    this.lifecycle.storage.sql.exec(
      "INSERT INTO ncr_burst (text, at) VALUES (?, ?)",
      text,
      Date.now(),
    );
    await this.#restartTimer();
    return this.size();
  }

  /**
   * The user is typing: restart the quiet timer if a burst is open. With no open burst
   * there is no timer to hold, so it does nothing. Returns whether it held one.
   */
  async hold(): Promise<boolean> {
    if (this.size() === 0) {
      return false;
    }
    await this.#restartTimer();
    return true;
  }

  async #restartTimer(): Promise<void> {
    await this.lifecycle.jobs.push({
      id: JOB_ID,
      fn: "flush",
      time: Date.now() + this.#options.delayMs,
    });
  }

  async onJob({ job }: LifecycleJobContext): Promise<void> {
    if (job.fn !== "flush") {
      return;
    }
    const bubbles = this.lifecycle.storage.sql
      .exec<Bubble>("SELECT seq, text, at FROM ncr_burst ORDER BY seq")
      .toArray();
    if (bubbles.length === 0) {
      return;
    }
    await this.#options.flush(joinBurst(bubbles), burstOperationId(bubbles));
    // Delete only what was handed over. A bubble that arrived during the flush pushed a
    // fresh job under the same id, which Lifecycle keeps over this run's result.
    this.lifecycle.storage.sql.exec(
      "DELETE FROM ncr_burst WHERE seq <= ?",
      bubbles.at(-1)?.seq ?? 0,
    );
  }
}
