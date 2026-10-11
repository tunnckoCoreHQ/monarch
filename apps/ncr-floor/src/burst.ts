/**
 * How long the floor waits after the newest bubble, or the newest typing signal, before
 * it closes the turn. Flat for now.
 */
export const BURST_DELAY_MS = 3000;

/**
 * The control frame a client sends while the user types. Every other frame is a bubble.
 * Clients send it at most about once a second, so it keeps an open burst from closing.
 */
export const TYPING_FRAME = JSON.stringify({ type: "typing" });

/** One message as the user sent it, in arrival order. */
export type Bubble = {
  readonly seq: number;
  readonly text: string;
  readonly at: number;
};

/** The turn Pi sees for a burst: each bubble on its own line, oldest first. */
export const joinBurst = (bubbles: readonly Bubble[]): string =>
  bubbles.map((bubble) => bubble.text).join("\n");

/**
 * Names a burst by its first and last bubble, so a flush that runs again after an
 * eviction submits the same Pi operation, and Pi admits it once.
 */
export const burstOperationId = (bubbles: readonly Bubble[]): string => {
  const first = bubbles[0];
  const last = bubbles.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error("An empty burst has no operation id");
  }
  return `burst:${first.seq}-${last.seq}`;
};

/**
 * Where a new bubble goes. An open burst keeps collecting, even while a reply runs.
 * With no open burst, a running reply takes the bubble as a Pi steer, and an idle
 * floor opens a new burst.
 */
export const route = ({
  buffered,
  busy,
}: {
  buffered: number;
  busy: boolean;
}): "buffer" | "steer" => (buffered === 0 && busy ? "steer" : "buffer");
