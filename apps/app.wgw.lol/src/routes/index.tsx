import { createFileRoute, Link } from "@tanstack/react-router";

import { RepoList } from "~/components/repo-list";
import { Kicker, Page, Terminal } from "~/components/site";
import { Button } from "~/components/ui/button";
import { api, type Repo } from "~/lib/api";

export const Route = createFileRoute("/")({
  loader: () => api<Repo[]>("/api/explore"),
  component: Home,
});

const FEATURES = [
  [
    "Public and private paths, one repo",
    "List paths in .gitprivate. Members clone everything; everyone else clones a public history where those paths never existed. Remove the line to publish.",
  ],
  [
    "Environments and secrets",
    "Production, staging, preview, development. Secrets are AES-GCM sealed in D1 and pulled by a scoped token: wgw env pull production.",
  ],
  [
    "Pull requests, merged at the edge",
    "Compare, review, comment, and merge without a CI box. Fast-forward when possible, a real three-way merge commit otherwise.",
  ],
  [
    "Agents commit without a clone",
    "POST files to /api/repos/:owner/:name/commits and get a commit back, with compare-and-swap on the branch tip.",
  ],
  [
    "Import any git remote",
    "Artifacts copies one branch from GitHub, GitLab, Codeberg, or any https remote. Members fork the full repo; everyone else forks the public one.",
  ],
  [
    "Agent sign-in",
    "AgentID for AgentMail inboxes, auth.md for any agent, and the device flow for the CLI.",
  ],
  [
    "Search code by meaning",
    "Each default branch is embedded with Workers AI and indexed in Vectorize. Members search every file; everyone else searches the public paths.",
  ],
  [
    "One-file CLI",
    "curl the installer and get wgw: repos, clones, commits, pull requests, environments, secrets, keys, and search, with no dependencies.",
  ],
  [
    "MCP",
    "Add app.wgw.lol/mcp to Claude Code, Cursor, or any MCP client. Repositories, files, code search, commits, and pull requests become tools, under the same scopes and private paths as the API.",
  ],
];

const STACK = [
  ["Artifacts", "git storage and the git protocol, imports, forks, and repo tokens"],
  ["Durable Objects", "one mirror per repository: public projection, merges, API commits"],
  ["Workers", "git proxy to Artifacts, REST API, auth"],
  ["D1", "accounts, tokens, pull requests, environments"],
  ["KV", "sign-in state and passkey challenges"],
  ["R2", "large objects in the mirror"],
  ["Workflows", "wait for imports and forks, then sync the mirror"],
  ["Workers AI", "pull request summaries and code search embeddings"],
  ["Vectorize", "code search by meaning over each default branch"],
  ["AI Gateway", "analytics and caching for every Workers AI call, with no prompt logs"],
  ["Analytics Engine", "clone, fetch, and push counts"],
  ["Rate Limiting", "sign-in, agent registration, and git token requests"],
  [
    "Queues",
    "Artifacts push events, so direct pushes reach the mirror in seconds; search index jobs",
  ],
  ["Secrets Store", "the master key for repository secrets, the signing key, the automation token"],
  ["Cron Triggers", "hourly push subscription checks, search backfill, and sign-in cleanup"],
  ["Workers Logs", "traces and errors from the Worker, the Durable Objects, and the queue"],
];

function Home() {
  const repos = Route.useLoaderData();
  return (
    <>
      <section className="border-b">
        <Page className="grid gap-10 py-16 md:grid-cols-[1.2fr_1fr] md:py-24">
          <div>
            <Kicker>git hosting on cloudflare</Kicker>
            <h1 className="mt-4 text-6xl leading-[0.9] font-black tracking-[-0.04em] md:text-8xl">
              Git,
              <br />
              rewired
              <br />
              <span className="text-signal">for agents.</span>
            </h1>
            <p className="text-muted-foreground mt-6 max-w-xl text-lg">
              Push, clone, review, and merge on Cloudflare's network. Cloudflare Artifacts stores
              the git data, and a Durable Object per repository runs merges and the public view.
              People sign in with Google and a passkey; agents sign in with AgentID or auth.md.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link to="/login">Start a repository</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href="/skill.md">Agent quickstart</a>
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-4 self-end">
            <Terminal title="people">{`curl -fsSL https://app.wgw.lol/install.sh | sh
wgw login
wgw repo create hello
git push wgw main`}</Terminal>
            <Terminal title="agents">{`curl https://app.wgw.lol/skill.md
curl https://app.wgw.lol/auth.md`}</Terminal>
          </div>
        </Page>
      </section>
      <section className="border-b">
        <Page className="py-0">
          <div className="bg-border grid gap-px border-x md:grid-cols-3">
            {FEATURES.map(([title, text]) => (
              <div key={title} className="bg-background p-6">
                <h3 className="text-lg font-extrabold tracking-tight">{title}</h3>
                <p className="text-muted-foreground mt-2 text-sm">{text}</p>
              </div>
            ))}
          </div>
        </Page>
      </section>
      <section className="border-b">
        <Page className="grid gap-8 md:grid-cols-[1fr_2fr]">
          <div>
            <Kicker>what runs where</Kicker>
            <h2 className="mt-3 text-3xl font-black tracking-tight">
              Sixteen Cloudflare products, no servers.
            </h2>
          </div>
          <dl className="bg-border grid gap-px border font-mono text-sm sm:grid-cols-2">
            {STACK.map(([name, role]) => (
              <div key={name} className="bg-background p-4">
                <dt className="text-signal font-bold">{name}</dt>
                <dd className="text-muted-foreground mt-1 text-xs">{role}</dd>
              </div>
            ))}
          </dl>
        </Page>
      </section>
      <Page>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-2xl font-black tracking-tight">Recently pushed</h2>
          <Link
            to="/explore"
            className="text-muted-foreground hover:text-foreground font-mono text-xs"
          >
            all public repositories →
          </Link>
        </div>
        <RepoList repos={repos.slice(0, 10)} empty="No public repositories yet." />
      </Page>
    </>
  );
}
