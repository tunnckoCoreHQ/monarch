# How always-on agents work (Lee Robinson): summary

A 45-minute lecture by Lee Robinson (formerly Cursor, now SpaceX) on how SpaceX built "Grok Bot", an always-on agent. Full notes are in [notes.md](./notes.md).

## The idea

The students' week-one agent is a model calling tools in a loop. Lee calls it very powerful, but "you close your laptop and the process stops." An always-on agent keeps the same loop and builds a system around it:

- It runs on a server and survives restarts and crashes.
- It has its own Linux computer in the cloud.
- It builds a memory of how you work.
- Slack, email, meetings, and routines can wake it, not only your typing.
- Like a colleague, it "knows when to be quiet."

The goal is agents that work for weeks or months. Lee says it feels like texting a friend who does real work for you.

## Why now

Models can follow instructions for hours or days. They hand work to sub-agents with fresh context. They call tools reliably, and Lee says hallucination is "kind of a solved problem mostly." They use computers by clicking, so sites with no API still work. They search files well. They learn skills by being shown. Auto review, a separate model checking commands, now does better than a tired human approving hundreds of shell commands.

## How it is built

- Server and computer both sleep by default. A trigger loads the agent's state on the server. The Firecracker VM starts only if a tool needs it. Lee says there are "not enough computers in the world" to run them all the time.
- A router deduplicates wake-ups, and the agent decides if anything is worth telling you.
- The agent loop lives on the server, not the VM. Then you can rebuild the VM (for example for a zero-day patch) without downtime, and ship agent code without App Store reviews.
- Durable workflows (Temporal) let a crashed task resume at step three instead of replaying steps one and two.
- Your own message interrupts the running turn. Everything else queues, and quick bursts of messages batch into one turn.

## The harness

- One tool, "send to user", is the only link between server and client. Any new client needs just that tool. The client renders rich UI for 1Password sign-ins, payments, email drafts, and reactions.
- Only tool names go in the prompt. The model reads details from a file when needed ("tool search tool").
- The agent climbs from cheap to expensive: what it knows, then an API, web search, its browser, the full desktop, and asking you last.
- The main agent stays sparse and hands heavy work to helpers. Each helper is a durable workflow. "This is how you get to a product that feels like it has infinite context."
- Give heavy shell patterns a dedicated tool. Write errors that tell the agent what to do next. Treat email and webhook text as untrusted. Ask before irreversible actions.

## Context engineering

- Keep the prompt start static and in a fixed order so the cache hits. Hash each section. OpenClaw's cache misses showed how costly this gets for always-on use.
- Warm the cache when the user starts typing.
- Compact right after a long session while the cache is still warm (10 to 60 minutes), so you come back to a cheap summary.
- Long outputs go to files, and screenshots go to helpers.
- Memory has layers: always-included user facts, ranked important facts, dated logs, short-lived scratch notes, and everything else searchable in files.

## Where it is going

- Every failure becomes an eval. Teams fix the harness daily and train new models on the evals every few months.
- "Delete the product." Today's models are the worst they will ever be, so build as little as possible.
- Open problems: evaluating month-long agents when models ship monthly, memory, security, knowing when to speak, and token efficiency.
- Every product will need durable workflows, sandboxes, memory, skills, connectors, voice, payments, identity, and evals, the way every 2005 web app needed a server, a database, and CRUD.

## Takeaways

1. Architecture decisions compound. Lee still reads the code he ships.
2. Build your own always-on agent from the week-one loop.
3. Learn how LLMs work, the way a web developer learns databases.
