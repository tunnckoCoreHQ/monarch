# ncr-floor

The MVP floor from [the NCR design notes](../../statics/ncr-identity-design/README.md): one Durable Object running a Pi Durable agent on Workers AI, one WebSocket, one user, one session. It has no auth, rooms, memory, or world system.

When a message arrives, the model doesn't run yet. The message waits in a buffer, and every new message restarts a 3 s quiet timer. While you type, the page sends a typing signal that restarts it too. When the timer fires, the whole burst goes to Pi as one turn, and the reply streams back over the socket. A message that arrives while a reply is running goes to Pi as a steer.

## Run it locally

Workers AI has no local simulator, so `cf dev` calls the real service on your Cloudflare account, and the usage counts against it. Log in once with `pnpm exec cf auth login`, or set `CLOUDFLARE_API_TOKEN`.

```sh
pnpm install
pnpm --filter ncr-floor run dev
```

Open http://localhost:5173. Each Enter sends one bubble. Send a few in a row and the status line shows them being held for one turn. The turn closes 3 s after your last message or keystroke.

On NixOS, workerd can't find the system CA bundle, and every model call fails with `TLS peer's certificate is not trusted`. Point it at the bundle:

```sh
SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt pnpm --filter ncr-floor run dev
```

Local state lives in `.cloudflare/state`. Delete `.cloudflare/state/v3/do` to start the session over.

## The socket

Connect to `/ws`. Send plain text frames, one per bubble. While the user types, send `{"type":"typing"}` at most about once a second. It restarts the timer of an open burst and does nothing otherwise. The server sends JSON:

| `type`     | When                                                              |
| ---------- | ----------------------------------------------------------------- |
| `history`  | On connect: the transcript so far, and how many bubbles are held. |
| `buffered` | A bubble joined the open burst. `count` is the burst's size.      |
| `steered`  | A bubble went to the running reply as a Pi steer.                 |
| `typing`   | A Pi run started.                                                 |
| `delta`    | Reply text as it streams.                                         |
| `reply`    | The finished reply.                                               |
| `idle`     | The run ended.                                                    |
| `error`    | The model call failed after Pi's retries.                         |

## How it works

- `src/floor.ts` is the Agent. It wires `PiHarness` (`agents/harness/pi`) to Workers AI through `agents/models/pi-ai`, forwards Pi's events to the sockets, and routes each bubble.
- `src/burst-buffer.ts` is the NCR layer. It's a Lifecycle capability that keeps bubbles in a SQLite table (`ncr_burst`) and flushes them with one Lifecycle job.
- `src/burst.ts` holds the pure parts: the routing rule, how a burst becomes one turn, and its operation id.

### The alarm

A Durable Object has one alarm, and the Agents SDK Lifecycle owns it. After every change to its job queue, Lifecycle sets the alarm for the earliest job. PiHarness puts its own job in that queue, one per session with work, to wake the object if it's evicted mid-run.

So the burst timer never calls `ctx.storage.setAlarm()` and never overrides `alarm()`. Setting the alarm directly would move Pi's wake-up, and Lifecycle's next re-arm would move ours back. The timer is a Lifecycle job pushed under a fixed id. Pushing again with that id replaces the pending job, which is the reset. Job ids belong to the capability that pushed them, so ours can't replace Pi's.

### Crashes and the mid-reply case

- **Durability.** Held bubbles are rows in SQLite, so they survive an eviction. The flush names each burst by its first and last row (`burst:4-6`) and passes that to Pi as the operation id. A flush that runs twice is admitted once.
- **Mid-reply messages.** A bubble that arrives during a reply, with no burst open, goes to Pi as a steer. Pi settings use `steeringMode: "all"`, so several of them join together. This agent has no tools, so Pi places a steer when the current reply finishes, then answers it in a follow-on run. Stopping the reply early is the design notes' mid-turn pivot, and it isn't built.

## Limits

- One user and one session: every socket joins the same object (`alex`) and Pi's root session.
- The event stream lives in memory. After an eviction, the next socket event reattaches it, so a reply that resumes after an eviction streams only to a client that reconnects or sends something.
- A client that joins mid-reply streams from its next delta onward, then gets the full text in `reply`.
- The app has no `deploy:nightly` script, so merging it deploys nothing.
