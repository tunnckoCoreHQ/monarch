import { createModels } from "@earendil-works/pi-ai/models";
import {
  type AgentEvent,
  type AgentEventStream,
  createRegistry,
  type EntryRecord,
  Harness,
} from "@earendil-works/pi-durable";
import { Agent, type Connection, type WSMessage } from "agents";
import { PiHarness } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";

import { BURST_DELAY_MS, route, TYPING_FRAME } from "./burst";
import { BurstBuffer } from "./burst-buffer";
import type { Env } from "./env";

const MODEL = "@cf/zai-org/glm-4.7-flash";

const PREAMBLE =
  "You are chatting with someone in a messaging app. They often send a few short messages in a row. Those arrive together as one turn, one message per line. Reply the way a person texts: short and natural, with no headings or lists.";

/**
 * What the socket sends the client. The client sends plain text frames, one per bubble,
 * plus `TYPING_FRAME` while the user types.
 */
type ServerMessage =
  | { type: "history"; messages: Bubble[]; buffered: number }
  | { type: "buffered"; count: number }
  | { type: "steered" }
  | { type: "typing" }
  | { type: "delta"; text: string }
  | { type: "reply"; text: string }
  | { type: "idle" }
  | { type: "error"; message: string };

type Bubble = { role: "user" | "assistant"; text: string };

/** A transcript entry as a chat bubble, or undefined for anything that is not one. */
const bubbleOf = (entry: EntryRecord): Bubble | undefined => {
  const message = entry.model?.[0];
  if (message?.role === "user") {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    return { role: "user", text };
  }
  if (message?.role === "assistant" && message.stopReason === "stop") {
    const text = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("");
    return { role: "assistant", text };
  }
  return undefined;
};

/**
 * The NCR floor: one identity, one Durable Object, one user, one Pi session (the root).
 * Bubbles collect in the burst buffer and reach Pi as one turn when the user goes quiet.
 * A bubble that lands while a reply runs goes to Pi as a steer instead.
 */
export class NcrFloor extends Agent<Env> {
  readonly ai = createAI({ binding: this.env.AI });

  readonly registry = createRegistry();

  readonly harness = new PiHarness({
    harness: ({ storage, context }) => {
      const models = createModels();
      models.setProvider(this.ai.provider);
      this.registry.install({
        name: "ncr",
        sections: [{ key: "preamble", render: () => PREAMBLE, tag: false }],
      });
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          // Several steers queued during one reply join it together, as one turn.
          settings: { steeringMode: "all", followUpMode: "all" },
        },
        context,
      );
    },
    // Chat needs a fast first reply. Locally, GLM 4.7 Flash took about 10 s with thinking off
    // and 27 to 43 s with it on "low". Defaults apply only when a session is first created.
    defaults: { model: this.ai(MODEL), thinkingLevel: "off" },
  });

  readonly burst = new BurstBuffer({
    delayMs: BURST_DELAY_MS,
    // A burst can close while a reply is already running, so it joins as a steer.
    flush: (input, operationId) => this.harness.submit(input, { operationId, whenBusy: "steer" }),
  });

  #events: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Both are Lifecycle capabilities, so they share the object's one alarm through its job queue.
    this.lifecycle.use(this.harness).use(this.burst);
  }

  override async onConnect(connection: Connection): Promise<void> {
    await this.#watch();
    const messages = (await this.harness.messages()).flatMap((entry) => bubbleOf(entry) ?? []);
    connection.send(
      JSON.stringify({
        type: "history",
        messages,
        buffered: this.burst.size(),
      } satisfies ServerMessage),
    );
  }

  override async onMessage(_connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message !== "string" || message.trim() === "") {
      return;
    }
    const text = message.trim();
    if (text === TYPING_FRAME) {
      await this.burst.hold();
      return;
    }
    await this.#watch();
    const busy = await this.harness.session().busy();
    if (route({ buffered: this.burst.size(), busy }) === "steer") {
      await this.harness.session().steer(text);
      this.#send({ type: "steered" });
      return;
    }
    this.#send({ type: "buffered", count: await this.burst.append(text) });
  }

  #send(message: ServerMessage): void {
    this.broadcast(JSON.stringify(message));
  }

  /**
   * Streams the root session's Pi events to every socket. One stream per isolate: it
   * lives in memory, so after an eviction the next socket event starts a new one.
   */
  #watch(): Promise<void> {
    this.#events ??= this.#attach().catch((error: unknown) => {
      this.#events = undefined;
      throw error;
    });
    return this.#events;
  }

  async #attach(): Promise<void> {
    const stream = await this.harness.session().events();
    stream.start(async (events) => {
      for (const event of events) {
        this.#forward(event);
      }
    });
    void this.#detachWhenClosed(stream);
  }

  async #detachWhenClosed(stream: AgentEventStream): Promise<void> {
    await stream.closed.catch(() => undefined);
    this.#events = undefined;
  }

  /** Turns the few Pi events a chat needs into socket messages, and drops the rest. */
  #forward(event: AgentEvent): void {
    if (event.type === "run_start") {
      this.#send({ type: "typing" });
    } else if (event.type === "message_update") {
      for (const change of event.changes) {
        if (change.type === "text_delta") {
          this.#send({ type: "delta", text: change.delta });
        }
      }
    } else if (event.type === "message_end") {
      const message = event.entry.model?.[0];
      if (message?.role === "assistant" && message.stopReason === "error") {
        this.#send({ type: "error", message: message.errorMessage ?? "The model call failed" });
        return;
      }
      const bubble = bubbleOf(event.entry);
      if (bubble?.role === "assistant") {
        this.#send({ type: "reply", text: bubble.text });
      }
    } else if (event.type === "run_end") {
      this.#send({ type: "idle" });
    }
  }
}
