# How always-on agents work (Lee Robinson): full notes

Source is the video `lee-robinson-how-alwayson-agents-work-CXXgkndDFiCXCSab.mp4` (45:17). It is a lecture in a course where students built a minimal agent loop in "week one" and studied harnesses the week before. Lee Robinson worked at Cursor and now works at SpaceX on "Grok Bot", an always-on agent product. He says up front that some of what he shows is still in progress at SpaceX. The recording stops before the Q&A.

These notes follow what Lee says, taken from a whisper.cpp transcript of the audio. Timestamps point into the video. Short version: [summary.md](./summary.md).

## Opening: from the week-one loop to an always-on agent (00:00)

The class built a simple harness: a model that calls tools in a loop. Lee says that alone is "very powerful" and unlocks a lot of what models can do. Its drawback is that "you close your laptop and the process stops."

The talk is about taking that same idea and extending it into an always-on agent. He lists what changes:

- It runs on a server in the cloud. You can close your computer, it can restart, and it survives crashes.
- It has its own computer. Not your laptop, but a Linux machine in the cloud with a desktop, files, a browser, "maybe some 3D apps".
- It saves files on that machine, understands your progress over time, and builds up a memory of how you work with it.
- It behaves more like a colleague than a terminal harness. A terminal harness answers every message. This agent "doesn't always immediately send you a message. It knows when to be quiet." It may work in the background and only come back when there is an important update.
- Things other than your typing can trigger it: a Slack message, an email, some other event.
- The hope is that it works over very long periods: "not just hours or days, but maybe even weeks or months." That needs a different architecture.

He promises to go "decently in depth" on how SpaceX built the architecture and the harness, and how they made the system proactive and persistent and good at following instructions.

## Part 1. How we got here (02:34)

Lee sees four eras of developers working with AI so far:

1. Copying code out of ChatGPT into your editor. "Feels like decades ago at this point, but it was really only a few years ago."
2. Agents in the terminal. Models got good enough for the simple harness from the previous lecture. They edit files and run shell commands. This "really took off" because the model could now do proactive work for you.
3. Coding agents got dedicated apps. People ran many agents in parallel, some in the cloud. But you were still the bottleneck. You reviewed every command, made sure every shell command was right, and stayed in the loop on everything.
4. Now, always-on agents. They run "ambiently in the background", with their own computer and memory. They learn new skills on the job and keep working after you go to bed or do other work.

### From approving to steering (04:07)

Before, you prompted an agent and waited, prompted and waited, and approved or rejected each shell command. Now you steer it. You say "go check this thread" and right after "oh, by the way, actually do that on Thursday." Older models got confused when you interrupted them with a new command. Current models parse it the way a friend parses you rambling, and they understand the two messages are related.

When you ask it to send an email or a Slack message, extra safety checks run. Many companies call this "auto review": a separate AI model checks every command that runs. Lee says that, funnily enough, this is more secure than a human approving each command, because of the fatigue of watching hundreds of shell commands. "If you did a blind test" between the model checking commands and a human checking them, "most of the time the model is actually doing a better job. Kind of paradoxically."

### Simpler interface (05:33)

As models got better, the interface got much simpler. SpaceX calls its always-on agent a "bot". Many similar products are appearing and gaining traction. His reason: "Everyone knows how to text." Working with AI now feels like texting a friend who can do real work for you. It is no longer Q&A. You hand it longer tasks, the way you would hand them to a coworker.

## Part 2. What changed in the models (06:13)

Lee goes over six changes and says there are more.

1. Long instruction following. Over the past one or two years, models got much better at following instructions over long periods without getting confused or making mistakes. With the right compression and compaction, they can now run "for hours or days" with confidence.
2. Sub-agents. A model's working memory fills up eventually. If it can hand work to helpers with a fresh working memory, that "effectively can give it an unlimited context". The helper does the work that is expensive in tokens or tool calls, then reports back to the main agent.
3. Tool use. A few years ago models "basically couldn't call tools very well, and they would hallucinate all the time." Lee: "You don't really hear people talk about hallucinations anymore because it's kind of a solved problem mostly." And you can give them powerful tools, the way you would onboard a new person: shell and files, a full Linux computer, making demo videos.
4. Computer use. Models click around a screen like a human, and they keep getting better at it. That means "any SaaS product or any website that didn't expose an API or an MCP server" can be used autonomously by the bot.
5. Information in files. You can store everything in files because models are very good at recalling and searching them.
6. Learning by being shown. You show the bot how to do some work, and it turns that into skills, memories, or routines it can reuse.

### Everything in files (08:29)

Lee walks through what the files look like under the hood, as a simplified example:

- A profile, your understanding of the user. It goes into every prompt. His example: you like lowercase text in messages, so every message must follow that.
- A working log, built up as you work together. "Just like if you were working with a colleague and they were writing down notes every day of the work that they've done." If you ask "what did I do last week?", it looks it up. Models are very good at Linux and shell commands, so they grep and search these files well.
- Skills. You take your knowledge of a task and encode it in a markdown file: the exact process and what makes it succeed or fail. There is a whole ecosystem of companies and developers writing skills, for example how to send a good email or build a good API. Grok Bot has plugins: for any tool you want to use, you install a plugin that brings skills or servers.
- Routines. Like cron jobs, a prompt that runs on a schedule.

His summary: "Basically, everything is computer."

## Part 3. Inside an always-on agent (10:04)

### Asleep by default (10:12)

At rest, both the server process and the agent's computer are asleep. A message from you or some other trigger starts the agent. Starting means loading all of the agent's state, on a server. If the agent decides it needs the computer, for example to use the browser or click around, it starts the computer too. When it is done, it puts both back to sleep.

Why this matters: running these computers all the time would be expensive, and "there's not enough computers in the world to just have those computers running all of the time for everyone." It would also mean a lot of server usage. So the state (conversation logs, memories, routines) is saved to a database.

### What wakes it up (11:13)

You can prompt it directly. Lee finds the other triggers more interesting: things running in the background that decide when to reach your bot.

- Someone pings you on Slack, and the bot lives in Slack.
- A phone call or a meeting. Lee: it is "increasingly common now at SpaceX" for employees to send their bot to a meeting they could have attended, to take notes and report back. "Kind of funny."
- A routine, or background work that took hours or days, comes back with a summary.

A router deduplicates these and decides how to put them into the conversation. Then the agent applies a heuristic: should it bother the user about this? Not everything is important. A coworker who came to you every time they made progress ("hey, check it out, I made progress") would be annoying. You probably want a status update maybe once a day, depending on the task.

### The agent's computer (12:18)

The Linux box is a Firecracker virtual machine. Firecracker makes it easy to snapshot the machine, shut it down, and start it back up.

- It has files. You can connect to it, get a live view, and control it yourself.
- It runs commands. That is good for shell commands you do not want on your own laptop. They run in a separate environment that is secured and locked down.
- It has Chrome. It can also give each bot its own virtual desktop, so if you run five or ten bots and each needs a browser, each gets its own screen.

This is shared infrastructure that the bots call on.

### Three parts (13:15)

Triggers come in on the left: apps, Slack messages, emails. The server is in the middle. The computer is on the right, for files and commands.

On the server, incoming commands go into a queue. The queue calls the agent loop, "which is what you covered last week. This is a model calling tools in a loop." When it shuts down, it saves state to the database and storage. Lee finds it interesting that there is one small piece, and all these abstractions are built on top of it. Give it helpful tools, connect it to many services, and you get a powerful product.

### Why the agent runs on the server (14:05)

Thin client, thick server is common practice. Computing has swung back and forth between the two over the years. His reasons:

- Updating agent code. "It would kind of suck if you had to push an App Store update just to get that code out", compared with pushing server updates quickly.
- Heavy computation, like transcription or image generation, is probably faster on a server than on the device.
- There are well-known ways to scale servers, especially with variable traffic and variable growth.
- The most critical one: if the agent loop ran on the virtual machine, you could not shut down the VM independently of the agent. So save everything on the server and you can always rebuild the VM. Example: a critical zero-day Linux update for the VM. You rebuild the VM without blowing away the whole agent loop and without downtime.

### When you hit send (15:25)

Lee says this part is "a little in the weeds" and glosses over it. He points to distributed systems, strong versus eventual consistency, as "fun topics to get into".

- You send a message and the client acknowledges it immediately.
- During the turn, the model calls tools in a loop and saves to the database.
- Clients subscribe to the server and listen for a signal that something changed. When they get one, they fetch the latest information from the server.
- Some deduplication ensures that retries do not show the same message several times.

### Durable workflows versus job queues (16:17)

Lee calls this the key infrastructure piece. You ask your agent to do a complicated task, and it moves through step one, two, three. Then an infrastructure problem crashes it. With a normal queue, the restart replays steps one, two, and three, which "could be pretty problematic." With a durable workflow, retrying is safe, and after a failure it "picks right up on step three."

This is "kind of a solved problem in some ways" in distributed systems. SpaceX uses the open-source tool Temporal so it does not have to rebuild this complicated machinery from scratch. You still have to run the infrastructure for it.

### Priorities for new messages (17:20)

Messages have different priorities. Lee messaging his own bot is different from a group chat, a Slack thread, or a background routine.

- If he says "actually, change the date for this event", the agent loop should stop. His message takes priority over everything else.
- Everything else goes to the back of the line.
- If the agent gets three or four messages very quickly, it batches them into one turn. "You can figure out whatever heuristic you want there."
- Then it processes one turn at a time.

## Part 4. The harness (18:06)

This part takes the basic harness from last week and adds new tools and concepts.

### One tool between client and server (18:20)

Lee calls this the biggest difference between Grok Bot's harness and probably other products like it. In their thin-client, thick-server design, only one tool communicates between client and server: "send to user." It is architecturally simple. "The client is just texting the server in some ways." The heavy tools live on the server: running shell commands, reading files, calling a cloud agent, recording your screen, making demos.

This has worked well because every new client (mobile app, desktop app, email, Slack) needs just this one tool.

### Rich UI on the client (19:15)

Even with one tool, the client decides how to display each result in the most useful, interactive way.

- If the user is trying to log into something, the client shows a dedicated sign-in form and connects to tools like 1Password.
- For payments, it calls services like Stripe Link or X Money.
- For things you cannot reverse, like sending an email or a Slack message, it may ask you to edit and approve a draft first.
- Sometimes it just leaves an emoji reaction if no message is needed.

### Dynamic tool discovery (19:59)

Every model has a context window, its working memory, limited in tokens. Each tool has a name, a schema, and other details. Install connectors for Google Drive, Gmail, YouTube, and other services that use MCP servers, and much of the window is full before any work starts. That leaves less room for the actual conversation.

A trick many popular harnesses now use is called "dynamic context", or by others the "tool search tool" ("which is a fun name"). Only the tool names go into every message. When the model wants a tool, it reads the details from a file. "It's kind of files in a file system all the way down." This saves context, cost, and usage. "Just better for everybody in general."

### Cheapest option first (21:29)

The principle is to try the cheapest or most reliable option first and work up the ladder:

1. What the bot already knows from the conversation history.
2. A plugin, MCP server, or API, for example pulling your banking data from Plaid.
3. A web search ("what was the score of the Cubs game last night?").
4. The computer's browser, doing searches there.
5. The entire desktop: run scripts, run commands, build things on the Linux machine.
6. Only if all of those fail, ask the user for input or approval.

This is what makes it feel like a colleague. "They're not going to bug you for all these different things, ideally. They're going to try a lot of these options first."

### Reading the computer's screen (22:37)

The agent has three ways to get information from the machine. It can take a screenshot, but there are more efficient ways. It can read the page's HTML. It can read the accessibility tree, which cuts token usage and helps find the buttons, links, and elements to click. If none of that works, it clicks on pixels, for example for modals and dialogs. The worst case is to go back to the user, for a two-factor code or a CAPTCHA.

### Main agent and helpers (23:29)

The main agent is your orchestrator. Keep its conversation "as sparse as possible", because it can call many helpers, and the helpers are sub-agents. Hand a helper a lot of shell commands or expensive tool calls, and none of that work bloats the main agent's context. Only the result comes back.

"This is how you get to a product that feels like it has infinite context." Infinite context is not real, and every model has a limit. But with these workarounds, especially when models are trained to use them, you do not feel the limit and you do not feel the quality drop as the conversation goes on.

- Each helper has different skills, and each helper is its own durable workflow. If the video helper crashes or uses too much memory, it restarts and continues without losing progress.
- The main agent is like a coworker managing your to-do list. You can check on a helper, send it a message, or stop the helpers.
- Much of this copies "the ideal way you would scale a team of engineers working on a very complicated problem."

### Lessons from building the tools (25:12)

- Do not add or remove tools during turns. This ties into prompt caching.
- Long tool descriptions and schemas take up context, which is bad for price and usage. There are many optimizations to trim them.
- People say a harness can have just one tool, running shell commands. That is true, and you can model a lot that way. But if the model spends 90% of its time running shell commands for one thing, a dedicated tool can be more efficient. It is also easier to read for the people reviewing how the product works.
- Error messages. For humans, good errors say what failed and what to do next, like "click on this link". "Turns out that's also very helpful for agents." There is developer experience in designing error messages for agents too.

### Security (26:28)

When you trust bots to work over long periods, you need to trust them with your information and with how they operate.

- Even though the agent works on its own machine and does not pollute yours, you still want a model to review every shell command before it runs: auto review.
- Untrusted input, like a phishing email in your inbox or a webhook, must not reach the model as if it were a user instruction. "There's plenty of work to do here in the industry" to protect against prompt injection.
- For actions you cannot reverse, like sending emails, ask the user first.
- Build workflows into the product that keep passwords and similar secrets out of the model conversation.

## Part 5. Context engineering (27:24)

Lee says context engineering is "also known as harness engineering. I feel like it's kind of the same thing, they've evolved over time." The question is how to minimize the context a harness uses, for efficiency, cost, and other reasons.

### Prompt caching (27:46)

With any coding agent or other agent, most tokens should be cached tokens. You send a conversation, add one message, and resend the whole conversation. Model pricing gives large discounts on cached tokens, and you want to stay in the cache window as long as possible. So keep the tool definitions, system prompt, and similar parts as static as possible between calls. Then only the newest message at the bottom is the uncached delta you pay full price for. "There's a whole art and science to this."

### Keep the main context small (28:46)

The main agent is the one you have a "very, very, very long conversation with." It compacts or summarizes its context many times, sometimes without you noticing. So keep its context small:

- Put any very long output in a file instead of the context. Agents are very good at reading files, the same way they read a skill or a memory.
- Delegate screenshots and other expensive work to a helper, so it does not touch the main context.
- Keep "gardening": trim and remove unnecessary content as you go, both for cost and for recall and model quality.

### A cache miss is a bug (29:52)

Lee goes back to January of the talk's year, when OpenClaw got popular and people used it inside model providers' subscription plans. That was a new usage pattern providers had not seen, and the harness was not tuned for it. There were many cache misses, which is a real problem when agents run all the time. Many fixes followed to keep the prompt cache as much as possible.

Tricks:

- Keep everything in the prompt in a fixed order. Even when you deploy a change to test a new system prompt section or add a tool, you can hash each section and keep the order fixed. Example: an A/B test that adds a prompt piece must not change the prompt order for everyone else. "Otherwise you just busted the cache."
- When you open the chat and start typing, the server prepares the prompt early to warm the cache, "almost like if you're on a website and you go to hover on a link, it can go and prefetch the next page."

"There's tons and tons of little engineering optimizations that compound", both in token usage and in how smart the models stay over long periods.

### Compaction (31:31)

Working over long periods means getting very good at compaction or summarization. Say the model has a 200,000-token context window. Eventually it has to summarize, and "all compression is lossy." You need an algorithm that compresses without losing important details. "I'm sure there's entire PhDs just for this problem."

The trick SpaceX uses: you go back and forth with your bot past 100,000 tokens, then you go do something else. Providers have a cache window when the cache is still warm, "maybe it's 10 minutes, maybe it's 60 minutes." While the cache is still warm, do the compaction right away, because it is much cheaper on the long conversation. When the user comes back 30 minutes later, they start from the summary, which is much cheaper to continue. There is still a lot of work to make summarization high quality.

### Memory layers (32:50)

Lee thinks about memory in layers:

- Facts about the user that must be in every message. Back to lowercase: if one message suddenly had uppercase letters while you are "going full Sam Altman style", that would be weird.
- Other facts and prompts worth including, chosen by an algorithm that decides which are most important. Ideally there is "garbage collection" of facts. He compares it to the brain: a fact matters now because it is relevant to today's conversation, and "you're probably not thinking about a soccer match right now."
- Dated logs of your past conversation history.
- Scratchpad notes: small things you are working on right now, meant to be ephemeral. They may matter for the next 30 minutes or an hour and then go away.
- Everything else is found through files. "This is the magic of files, of the models being good at running commands. They can always just go look stuff up, and they're actually very good at doing that."

## Part 6. Where this is going (34:26)

### Training the model for the product (34:30)

Lee gives a short refresher on training an LLM:

- Pre-training: the model learns a general understanding of the world from large amounts of internet text or private data.
- Supervised fine-tuning (SFT): you teach the model to behave a certain way, as a chat assistant or as an agent.
- Reinforcement learning: "kind of like teaching the model how to play games and get better at those games."

For always-on agents, SFT shows the model examples of the harness so it learns the available tools. RL makes it better at following instructions, picking the right skill out of hundreds, and clicking the right spots in a browser.

Serving matters too, not only training. The main agent you talk to should have very low latency and reply right away. You can tune harness and inference for that. But when a helper works for a very long time, "the difference between 10 minutes and 12 minutes is kind of negligible." That lets you optimize each one differently.

### The flywheel (36:05)

- Inner loop. Your agent gets something wrong, for example it calls a tool it was not supposed to. That becomes an eval. The team fixes the harness, the bug, the prompt, or the inference, confirms the fix in the evals, and ships. Product teams do this "every single day".
- Outer loop. Every month or few months you train new models. Ideally they learn from these bugs and failures and climb the evals you care about. You drop the new version into the product and check that it improves.
- New models bring capability jumps, and people use the product in new ways. Lee's example: there has not been much training data on bots in group chats. "This is kind of an emergent thing." He mentions Moltbook and "the Hugging Face incident" as cases where it went badly. Models need training to behave well in multi-agent systems where bots talk to each other.

### Delete the product (37:44)

A principle at Cursor and now at SpaceX. "You kind of have to internalize and assume that the models today are the worst they'll ever be." In six months you might need to completely rebuild the UI. Most of this talk would have been very different six months ago, and definitely a year ago, because the team learned so much about building harnesses and context engineering. The strategy is to build for the next model generation: build as little as possible and keep a very simple interface that lets the models think and act for you.

### Next 6 to 12 months (38:32)

Lee calls these "decently safe bets":

- Today bots work for a few hours, maybe a day on hard tasks. Soon they may work for weeks or months. That raises questions about how to train and evaluate them.
- Models will get much better at recalling past information from conversations. Research is trying many approaches: different algorithms, and different data representations ("maybe it's a graph, maybe it's files, maybe something else").
- Ideally you give a digital colleague "literally all the tools" you would give a new human hire. Organizations are still warming up to that.
- Interfaces may get even simpler. Some people will want speech-to-speech, "maybe they'll have their Jony Ive device that is hopefully really cool" and talk to it all day.
- Models and products will get very good at learning skills on the job and encoding them in files, instructions, and skills, turning raw intelligence into something useful for your task.
- People and companies will get much better at writing down their bespoke processes so agents can use them.

### Open problems (40:20)

Lee offers these as ideas to research:

- Evaluating agents that run for a month when models ship every month. You cannot fully confirm a model behaves as expected over a month. Either evals get better, or models ship more slowly. He thinks the industry has to solve this in the next six months.
- Memory, and the algorithms behind it.
- Security: building a secure harness and secure infrastructure so agents cannot be taken over by bad actors.
- When the agent stays silent and when it bothers you. "I don't think that we have it perfect yet." Example: "Hey, I saw that you missed class yesterday, I took the notes, here's the thing." Maybe helpful, maybe annoying. Finding the balance is still open.
- Token efficiency. "A pretty safe bet" is that a year from now far more tokens will flow through the world, so optimizing inference, models, and harnesses to use fewer tokens will matter a lot.

### The new building blocks (42:03)

Lee credits a post on X by Alex from OpenRouter. People said every AI app today looks the same: a sidebar, an agent, a chat box. Alex's answer: in 2005 everyone built the same thing too, a server, a database, and a CRUD interface. This is the new normal. Every new product will have an agentic side, or it will become "a headless piece of data for another agent to use."

The pieces from this talk are the new building blocks: durable workflows, sandboxes and cloud computers, memory, skills, connectors to other services, voice, payments, identity, evals. "Each one of those boxes is like multiple billions of dollars of VC capital, probably trillions." There are about 20 startups for each, and they all have to integrate with harnesses.

## Takeaways (43:20)

- System design and architecture matter more than ever, because those decisions compound. Lee is "still pro looking at code" and still reads the code he ships, mainly to understand the architecture. "It's crazy how much that's changed in just a couple years."
- Build your own version. Apply today's ideas to your week-one harness. He guesses an "open Grok Bot" already exists on GitHub, and you could add a GUI, a sandbox, a VM, and more.
- Learn how LLMs work. You do not need deep ML or the science side. It is like knowing how databases work when you build a web app. Many product and harness decisions are shaped by the models, and an intuition for them puts you in a good position for any role.

## Lessons worth keeping

My own extraction of what applies beyond Grok Bot.

### Architecture

- Keep the agent loop small and build everything else around it: triggers, a queue, a state store, a sandbox, channels.
- Keep all state on the server and treat the VM as disposable, so you can patch, rebuild, or sleep it without touching the agent.
- Use durable workflows for agent steps. Replaying finished steps after a crash wastes money and can repeat side effects.
- Make retries safe with deduplication. Clients listen for "something changed" and fetch from the server.
- Process one turn at a time per conversation. The owner's message preempts. Everything else queues and gets batched.
- Sleep whatever is idle. Always-on is only affordable when idle costs close to nothing.

### Harness and tools

- Give the agent one tool for talking to the user. Silence becomes the default, and new clients are cheap to add.
- Let the client render purpose-built UI for logins, payments, and irreversible sends, so secrets stay out of the model.
- Load tool names up front and tool details on demand.
- Climb from cheap to expensive, and ask the human last.
- For screens, use the accessibility tree before HTML, HTML before screenshots, and screenshots before pixel clicks.
- Keep tools fixed during a conversation. Write errors that tell the agent what to do next.
- If one shell pattern takes most of the agent's time, give it a dedicated tool.

### Context and cost

- The cache is the budget. Static content goes first in a fixed order. Hash sections. Treat a miss as a bug.
- Warm the cache when the user starts typing.
- Compact while the cache is still warm, not when the user returns.
- Keep the main context small. Long outputs go to files, and expensive work goes to helpers.
- Layer memory: always-on user facts, ranked important facts, dated logs, short-lived scratch notes, and searchable files for the rest.

### Safety

- Model-based auto review beats a tired human approving hundreds of commands.
- Treat email and webhook text as untrusted, never as instructions.
- Ask before irreversible actions, and run the agent on its own locked-down machine.

### Strategy

- Assume models get better within six months, and build as little as possible around them.
- Every failure becomes an eval. Evals drive daily harness fixes and the next training run.
- Tune latency per role: a fast main agent and slower, reliable helpers.

## Appendix: details shown only on the slides

Lee did not say these out loud, but the slides showed them:

- The agent process stops after 2 idle minutes. The VM goes to sleep a few minutes after the last activity, never mid-turn. Files sync to cloud storage, and memory and disk are saved as a snapshot.
- The VM is "one per user" and runs a Debian container kept alive by a supervisor.
- Every client update has a sequence number. Apps apply updates in order and reload from the database if one is missing.
- Each tool's description and schema stays under 4,000 characters. An example error reads: "The computer is asleep. Use Shell or Read to wake it, then try again."
- If auto review blocks an action, you get an approval request. No answer in 15 seconds means blocked. New routines need your OK.
- If a deploy changes a tool description, running conversations get a note instead of the new text.
- The profile holds up to 100 facts in 4,000 characters. The 30 most relevant recent log entries go into the prompt. A pass after each turn adds and replaces facts, and it can only remove facts it was shown. Each agent writes to its own file, and all your agents share the facts about you.
- Compaction is skipped if background work is about to wake the agent anyway. The agent's last few messages are kept word for word.

## Names in the transcript

The transcript is automatic, so a few names are my best reading of the audio: "open claw" is OpenClaw, "multbook" is likely Moltbook, "Johnny I've device" is a Jony Ive device, and "temporal" is Temporal.
