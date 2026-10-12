#!/usr/bin/env node
// wgw: the command line for app.wgw.lol. One file, no dependencies, Node 20+ or Bun.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const VERSION = "0.1.0";
const HOST = (process.env.WGW_HOST ?? "https://app.wgw.lol").replace(/\/+$/, "");
const CONFIG = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "wgw",
  "config.json",
);

const HELP = `wgw: git hosting for people and agents at ${HOST}

Sign-in
  wgw login                      approve this terminal in the browser; stores an API key
  wgw login --token <key>        store an existing key (or set WGW_TOKEN)
  wgw logout | wgw whoami
  wgw setup-git                  make plain git use the stored key for ${new URL(HOST).host}

Repositories
  wgw repo create <name> [--private] [--description <text>]
                  [--import <https url> [--import-branch <name>]]   imports one branch
  wgw repo list [owner]          wgw repo view [owner/name] [--json]   shows status
  wgw repo fork [owner/name] [--name <new>]
  wgw repo delete <owner/name> --yes
  wgw clone <owner/name> [dir]   members get the private paths too

Direct Artifacts access
  wgw repo token [owner/name] [--write] [--json]   a 1-hour token for the Artifacts git remote
  eval "$(wgw repo token)"       sets WGW_GIT_REMOTE and WGW_GIT_TOKEN in this shell

Files without a clone
  wgw ls [path] [--ref <ref>]    wgw cat <path> [--ref <ref>]
  wgw log [--ref <ref>] [--limit <n>]   newest first; 20 by default, up to 200
  wgw commit [--branch <b>] -m <message> <repo/path=local/file>... [--delete <path>]
             [--expected-sha <sha>] [--from <ref>]
      --branch defaults to the default branch. A new branch starts from the default branch,
      or from --from. --expected-sha fails the commit when the branch moved.

Search
  wgw search "<query>" [-R owner/name] [--limit <n>] [--json]   code by meaning; 10 results by
      default, up to 50. Outside a clone and without -R, all public repositories.

Pull requests
  wgw pr create --head <branch> [--base <branch>] --title <text> [--body <text>]
  wgw pr list [--state open|merged|closed|all]
  wgw pr view <n> | diff <n> | merge <n> | close <n> | reopen <n> | summary <n>
  wgw pr comment <n> [--body <text>]   reads stdin without --body

Commit statuses
  wgw status set <sha> <pending|success|failure|error> [--context <name>] [--description <text>]
                 [--url <https url>]    posting a context again replaces it; context defaults to default
  wgw status list <sha> [--json]       each context and the combined state

Environments and secrets
  wgw env list | env create <name> [--kind production|staging|preview|development] | env delete <name>
  wgw secret set <NAME> [--env <name>] [--plain] [<value>]   (reads stdin without a value)
  wgw secret delete <NAME> [--env <name>]
  wgw env pull [<name>] [--json]  prints dotenv lines, repository values first

Access
  wgw key create <name> [--scopes read,write,admin,secrets] [--repo owner/name] [--env <name>] [--days 90]
  wgw key list | key revoke <id>
  wgw collab list | collab add <handle> [--role read|write|admin] | collab remove <handle>

Webhooks
  wgw hook list | hook create <https url> [--events push,pull_request,pull_request_comment,repository]
      --events defaults to push. create prints the signing secret once.
  wgw hook ping <id> | hook deliveries <id> | hook delete <id>

Other
  wgw api <METHOD> <path> [json]   raw API call, prints the response
  wgw version | wgw --version
  -R owner/name                    pick the repository. A positional owner/name wins, then -R,
                                   then the git remote of this clone that points at ${new URL(HOST).host}
  --flag value or --flag=value     a value may start with a dash: --body "- item"
`;

function fail(message) {
  console.error(`wgw: ${message}`);
  process.exit(1);
}

/** Fails with the usage line unless the value is a non-empty string. */
function required(value, usage) {
  if (typeof value !== "string" || value === "") {
    fail(`usage: ${usage}`);
  }
  return value;
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function token() {
  return process.env.WGW_TOKEN ?? readConfig().token;
}

const SHORT_FLAGS = new Map([
  ["-R", "repo"],
  ["-m", "message"],
  ["-h", "help"],
]);
const BOOLEAN_FLAGS = new Set(["private", "yes", "plain", "json", "write", "help", "version"]);
const VALUE_FLAGS = new Set([
  "repo",
  "message",
  "token",
  "description",
  "import",
  "import-branch",
  "name",
  "ref",
  "limit",
  "branch",
  "delete",
  "expected-sha",
  "from",
  "head",
  "base",
  "title",
  "body",
  "state",
  "kind",
  "env",
  "scopes",
  "days",
  "role",
  "context",
  "url",
  "events",
]);

/** A value flag takes the next argument as it is, so `--body "- item"` keeps its text. */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let name = SHORT_FLAGS.get(arg);
    let inline;
    if (name === undefined && arg.startsWith("--") && arg.length > 2) {
      const at = arg.indexOf("=");
      name = arg.slice(2, at === -1 ? undefined : at);
      inline = at === -1 ? undefined : arg.slice(at + 1);
    }
    if (name === undefined) {
      positional.push(arg);
    } else if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) {
        fail(`--${name} takes no value`);
      }
      flags[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) {
        fail(`${arg} needs a value`);
      }
      flags[name] = value;
    } else {
      fail(`unknown flag ${arg}; run wgw help`);
    }
  }
  return { positional, flags };
}

/**
 * `raw: true` returns the body as text; `raw: "bytes"` returns it as a Buffer. `hint` maps a
 * failed status and message to a hint, or to undefined for none.
 */
async function call(method, path, body, { raw = false, auth = true, hint } = {}) {
  const headers = { accept: "application/json" };
  const key = token();
  if (auth && key) {
    headers.authorization = `Bearer ${key}`;
  }
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${HOST}${path}`, init);
  if (res.ok && raw === "bytes") {
    return Buffer.from(await res.arrayBuffer());
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text).message ?? text;
    } catch {
      // The body is not JSON; show it as it is.
    }
    let note = hint?.(res.status, message);
    if (note === undefined && res.status === 401) {
      note =
        process.env.WGW_TOKEN === undefined
          ? "run `wgw login`"
          : "WGW_TOKEN is set; it overrides the stored key";
    }
    fail(`${res.status} ${message}${note === undefined ? "" : ` (${note})`}`);
  }
  if (raw) {
    return text;
  }
  return text === "" ? null : JSON.parse(text);
}

/** The -R repository, else the one the git remote points at, else undefined. */
function detectRepo(flags) {
  if (typeof flags.repo === "string") {
    return flags.repo;
  }
  try {
    const remotes = execFileSync("git", ["remote", "-v"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const host = new URL(HOST).host.replace(/\./g, "\\.");
    const match = new RegExp(`${host}/([^/\\s]+)/([^/\\s]+?)(?:\\.git)?\\s`).exec(remotes);
    if (match) {
      return `${match[1]}/${match[2]}`;
    }
  } catch {
    // Not inside a git repository.
  }
  return undefined;
}

function ownerName(repo) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    fail(`expected owner/name, got ${repo}`);
  }
  return repo;
}

/** A positional owner/name, else -R, else the git remote of this clone. */
function pickRepo(flags, target) {
  return ownerName(
    target ?? detectRepo(flags) ?? fail("no repository: pass -R owner/name or run inside a clone"),
  );
}

function base(flags, target) {
  const [owner, name] = pickRepo(flags, target).split("/");
  return `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function print(value) {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function ago(seconds) {
  const diff = Date.now() / 1000 - seconds;
  if (diff < 3600) {
    return `${Math.max(1, Math.round(diff / 60))}m ago`;
  }
  if (diff < 86400) {
    return `${Math.round(diff / 3600)}h ago`;
  }
  return `${Math.round(diff / 86400)}d ago`;
}

function setupGit() {
  const host = new URL(HOST).origin;
  // The runtime goes by name, not by path, so the helper still runs after a Node upgrade.
  const runtime = process.versions.bun === undefined ? "node" : "bun";
  git([
    "config",
    "--global",
    `credential.${host}.helper`,
    `!${runtime} "${process.argv[1]}" git-credential`,
  ]);
  // Public repositories answer anonymous requests, so git must send the key up front for members
  // to receive private paths.
  git(["config", "--global", `http.${host}.proactiveAuth`, "basic"]);
}

/** Runs git. Its stderr is shown after it exits; on a failure, its first error line. */
function git(args) {
  const result = spawnSync("git", args, {
    encoding: "utf-8",
    stdio: ["inherit", "inherit", "pipe"],
  });
  const command = args[0] === "-c" ? args[2] : args[0];
  if (result.status !== 0) {
    const lines = (result.stderr ?? "").trim().split("\n");
    const reason =
      result.error?.message ??
      lines.find((line) => line.startsWith("fatal:") || line.startsWith("error:")) ??
      lines.at(-1);
    fail(`git ${command} failed${reason ? `: ${reason}` : ""}`);
  }
  process.stderr.write(result.stderr);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").replace(/\n$/, "");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function login(flags) {
  if (typeof flags.token === "string") {
    writeConfig({ ...readConfig(), token: flags.token });
  } else {
    const code = await call(
      "POST",
      "/api/device/code",
      { client_name: `wgw cli on ${process.env.HOSTNAME ?? process.platform}` },
      { auth: false },
    );
    console.log(`Open ${code.verification_uri_complete}`);
    console.log(`and confirm the code ${code.user_code}. Waiting…`);
    let interval = code.interval;
    for (;;) {
      await sleep(interval * 1000);
      const res = await fetch(`${HOST}/api/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: code.device_code }),
      });
      const data = await res.json();
      if (res.ok) {
        writeConfig({ ...readConfig(), token: data.token });
        break;
      }
      if (data.error === "slow_down") {
        interval += 5;
      } else if (data.error !== "authorization_pending") {
        fail(`login failed: ${data.error}`);
      }
    }
  }
  const me = await call("GET", "/api/me");
  writeConfig({ ...readConfig(), handle: me.handle });
  setupGit();
  console.log(`Signed in as @${me.handle}. Git now uses this key for ${HOST}.`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...args] = positional;
  if (flags.version || command === "version") {
    console.log(VERSION);
    return;
  }
  if (flags.help || command === undefined || command === "help") {
    console.log(HELP);
    return;
  }
  switch (command) {
    case "login": {
      return login(flags);
    }
    case "logout": {
      writeConfig({});
      console.log("Forgot the stored key.");
      return;
    }
    case "whoami": {
      return print(await call("GET", "/api/me"));
    }
    case "setup-git": {
      setupGit();
      console.log("git now sends the stored key to", HOST);
      return;
    }
    case "git-credential": {
      if (args[0] === "get" && token()) {
        process.stdout.write(`username=x\npassword=${token()}\n`);
      }
      return;
    }
    case "clone": {
      const [target, dir] = args;
      const repo = ownerName(required(target, "wgw clone <owner/name> [dir]"));
      const cloneArgs = ["-c", "http.proactiveAuth=basic", "clone", `${HOST}/${repo}.git`];
      if (dir !== undefined) {
        cloneArgs.push(dir);
      }
      return git(cloneArgs);
    }
    case "repo": {
      return repo(args, flags);
    }
    case "ls": {
      const query = new URLSearchParams({ path: args[0] ?? "", ref: flags.ref ?? "" });
      const tree = await call("GET", `${base(flags)}/tree?${query}`);
      for (const item of tree.items) {
        console.log(
          `${item.type === "tree" ? "dir " : "file"}  ${item.path}${item.type === "tree" ? "/" : ""}`,
        );
      }
      return;
    }
    case "cat": {
      const path = required(args[0], "wgw cat <path> [--ref <ref>]");
      const query = new URLSearchParams({ path, ref: flags.ref ?? "" });
      process.stdout.write(
        await call("GET", `${base(flags)}/raw?${query}`, undefined, { raw: "bytes" }),
      );
      return;
    }
    case "log": {
      const query = new URLSearchParams({ ref: flags.ref ?? "", limit: flags.limit ?? "20" });
      for (const commit of await call("GET", `${base(flags)}/commits?${query}`)) {
        console.log(
          `${commit.sha.slice(0, 7)}  ${commit.message.split("\n")[0]}  (${commit.author.name}, ${ago(commit.committer.time)})`,
        );
      }
      return;
    }
    case "commit": {
      return commit(args, flags);
    }
    case "search": {
      return search(args[0], flags);
    }
    case "pr": {
      return pr(args, flags);
    }
    case "status": {
      return status(args, flags);
    }
    case "env": {
      return env(args, flags);
    }
    case "secret": {
      return secret(args, flags);
    }
    case "key": {
      return key(args, flags);
    }
    case "collab": {
      return collab(args, flags);
    }
    case "hook": {
      return hook(args, flags);
    }
    case "api": {
      const usage = "wgw api <METHOD> <path> [json]";
      const [method, path, json] = args;
      required(method, usage);
      if (!required(path, usage).startsWith("/")) {
        fail(`the path starts with /, like /api/me; got ${path}`);
      }
      return print(
        await call(method.toUpperCase(), path, json === undefined ? undefined : JSON.parse(json), {
          raw: true,
        }),
      );
    }
    default: {
      fail(`unknown command ${command}; run wgw help`);
    }
  }
}

const STATUS_NOTES = {
  importing: "Artifacts is importing the repository. Files and history appear when it is ready.",
  forking: "Artifacts is forking the repository. Files and history appear when it is ready.",
  failed: "The import or fork did not finish. Delete the repository and try again.",
};

function showRepo(item) {
  const status = item.status ?? "ready";
  let access;
  if (item.role === null) {
    access = "none, public view";
  } else if (item.role !== undefined) {
    access = `${item.role}, ${item.view} view`;
  }
  const rows = [
    ["status", status],
    ["detail", item.status_detail],
    ["default branch", item.default_branch],
    ["branches", item.branches?.join(", ")],
    ["tags", item.tags?.join(", ")],
    ["open pulls", item.open_pulls],
    ["clone", item.clone_url],
    ["web", item.web_url],
    ["imported from", item.source],
    ["forked from", item.forked_from],
    ["your access", access],
  ];
  console.log(`${item.full_name}  ${item.visibility}`);
  if (item.description) {
    console.log(item.description);
  }
  console.log("");
  for (const [label, value] of rows) {
    if (value !== undefined && value !== null && value !== "") {
      console.log(`${label.padEnd(15)} ${value}`);
    }
  }
  if (STATUS_NOTES[status] !== undefined) {
    console.log(`\n${STATUS_NOTES[status]}`);
  }
}

/** Single-quotes a value for POSIX shells, so `eval "$(wgw repo token)"` is safe. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function gitToken(target, flags) {
  const scope = flags.write ? "write" : "read";
  const grant = await call("POST", `${base(flags, target)}/git-token`, { scope });
  if (flags.json) {
    return print(grant);
  }
  console.log(`export WGW_GIT_REMOTE=${shellQuote(grant.remote)}`);
  console.log(`export WGW_GIT_TOKEN=${shellQuote(grant.token)}`);
  // The hint goes to stderr, so eval only sees the two export lines.
  const header = 'git -c http.extraHeader="Authorization: Bearer $WGW_GIT_TOKEN"';
  console.error(
    `# ${grant.scope} token for the ${grant.view} repository, expires ${grant.expires_at}`,
  );
  console.error(`# ${header} clone "$WGW_GIT_REMOTE"`);
  if (grant.scope === "write") {
    console.error(`# ${header} push "$WGW_GIT_REMOTE" HEAD`);
  }
}

async function repo([action, target], flags) {
  if (action === "create") {
    const name = required(
      target,
      "wgw repo create <name> [--private] [--description <text>] [--import <https url>]",
    );
    const branch = flags["import-branch"];
    if (branch !== undefined && !flags.import) {
      fail("--import-branch needs --import <https url>");
    }
    const created = await call("POST", "/api/repos", {
      name,
      description: flags.description,
      visibility: flags.private ? "private" : "public",
      import_url: flags.import,
      import_branch: branch,
    });
    console.log(`${created.web_url}\n${created.clone_url}`);
    if (created.status === "importing") {
      console.log(
        `Importing. Run \`wgw repo view ${created.full_name}\` until the status is ready.`,
      );
    }
    if (existsSync(".git") && !flags.import) {
      spawnSync("git", ["remote", "add", "wgw", created.clone_url], { stdio: "ignore" });
      console.log("Added git remote `wgw`. Push with: git push wgw HEAD");
    }
    return;
  }
  if (action === "list") {
    const query = target === undefined ? "" : `?owner=${encodeURIComponent(target)}`;
    for (const item of await call("GET", `/api/repos${query}`)) {
      const status =
        item.status === undefined || item.status === "ready" ? "" : `[${item.status}] `;
      console.log(
        `${item.full_name.padEnd(40)} ${item.visibility.padEnd(8)} ${status}${item.description}`,
      );
    }
    return;
  }
  if (action === "view") {
    const item = await call("GET", base(flags, target));
    return flags.json ? print(item) : showRepo(item);
  }
  if (action === "token") {
    return gitToken(target, flags);
  }
  if (action === "fork") {
    const forked = await call(
      "POST",
      `${base(flags, target)}/fork`,
      { name: flags.name },
      {
        hint: (status, message) =>
          status === 409 && message.endsWith("already exists") && flags.name === undefined
            ? "pass --name <new> to fork under another name"
            : undefined,
      },
    );
    console.log(forked.clone_url);
    if (forked.status === "forking") {
      console.log(`Forking. Run \`wgw repo view ${forked.full_name}\` until the status is ready.`);
    }
    return;
  }
  if (action === "delete") {
    // Deleting never falls back to the git remote: the repository must be named.
    const name = ownerName(required(target ?? flags.repo, "wgw repo delete <owner/name> --yes"));
    if (!flags.yes) {
      fail(`pass --yes to delete ${name}`);
    }
    await call("DELETE", base(flags, name));
    console.log(`Deleted ${name}`);
    return;
  }
  fail("usage: wgw repo create|list|view|token|fork|delete");
}

async function commit(specs, flags) {
  const usage =
    "wgw commit [--branch <b>] -m <message> <repo/path=local/file>... [--delete <path>] [--expected-sha <sha>] [--from <ref>]";
  required(flags.message, usage);
  const files = specs.map((spec) => {
    const at = spec.indexOf("=");
    if (at < 1 || at === spec.length - 1) {
      fail(`expected repo/path=local/file, got ${spec}`);
    }
    const local = spec.slice(at + 1);
    let content;
    try {
      content = readFileSync(local);
    } catch (error) {
      fail(`cannot read ${local}: ${error.code === "ENOENT" ? "no such file" : error.message}`);
    }
    return { path: spec.slice(0, at), content: content.toString("base64"), encoding: "base64" };
  });
  if (flags.delete !== undefined) {
    files.push({ path: flags.delete, delete: true });
  }
  if (files.length === 0) {
    fail(`usage: ${usage}`);
  }
  const result = await call("POST", `${base(flags)}/commits`, {
    branch: flags.branch,
    message: flags.message,
    expected_sha: flags["expected-sha"],
    from: flags.from,
    files,
  });
  console.log(`${result.sha}  ${result.branch}`);
}

/** Searches one repository, or every public repository when there is none to pick. */
async function search(query, flags) {
  if (query === undefined || query.trim() === "") {
    fail('usage: wgw search "<query>" [-R owner/name] [--limit <n>] [--json]');
  }
  const repo = detectRepo(flags);
  const params = new URLSearchParams({ q: query, limit: flags.limit ?? "10" });
  const path = repo === undefined ? "/api/search" : `${base(flags, repo)}/search`;
  const hits = await call("GET", `${path}?${params}`);
  if (flags.json) {
    return print(hits);
  }
  if (hits.length === 0) {
    console.log("No matches.");
  }
  for (const hit of hits) {
    const where = hit.owner === undefined ? "" : `${hit.owner}/${hit.name}  `;
    console.log(`${where}${hit.path}:${hit.start_line}-${hit.end_line}  (${hit.score.toFixed(3)})`);
    for (const line of hit.snippet.split("\n").slice(0, 3)) {
      console.log(`    ${line}`);
    }
    console.log("");
  }
}

const NUMBERED_PR_ACTIONS = new Set([
  "view",
  "diff",
  "merge",
  "close",
  "reopen",
  "comment",
  "summary",
]);

async function pr([action, number], flags) {
  if (NUMBERED_PR_ACTIONS.has(action)) {
    if (!/^\d+$/.test(number ?? "")) {
      fail(`usage: wgw pr ${action} <number>${action === "comment" ? " [--body <text>]" : ""}`);
    }
  } else if (action === "create") {
    if (flags.head === undefined || flags.title === undefined) {
      fail("usage: wgw pr create --head <branch> [--base <branch>] --title <text> [--body <text>]");
    }
  } else if (action !== "list") {
    fail("usage: wgw pr create|list|view|diff|merge|close|reopen|comment|summary");
  }
  const root = `${base(flags)}/pulls`;
  switch (action) {
    case "create": {
      const created = await call("POST", root, {
        title: flags.title,
        body: flags.body,
        head: flags.head,
        base: flags.base,
      });
      console.log(created.web_url);
      return;
    }
    case "list": {
      for (const item of await call("GET", `${root}?state=${flags.state ?? "open"}`)) {
        console.log(
          `#${String(item.number).padEnd(4)} ${item.state.padEnd(7)} ${item.title}  (${item.head} -> ${item.base}, @${item.author})`,
        );
      }
      return;
    }
    case "view": {
      const item = await call("GET", `${root}/${number}`);
      console.log(
        `#${item.number} ${item.title} [${item.state}]\n${item.head} -> ${item.base} by @${item.author}\n\n${item.body}`,
      );
      if (item.compare?.commits) {
        console.log(
          `\n${item.compare.commits.length} commits, ${item.compare.files.length} files, ${item.compare.mergeable ? "mergeable" : "not mergeable"}`,
        );
      }
      return;
    }
    case "diff": {
      process.stdout.write(await call("GET", `${root}/${number}/diff`, undefined, { raw: true }));
      return;
    }
    case "merge": {
      return print(await call("POST", `${root}/${number}/merge`, {}));
    }
    case "close":
    case "reopen": {
      await call("PATCH", `${root}/${number}`, { state: action === "close" ? "closed" : "open" });
      console.log(`#${number} ${action === "close" ? "closed" : "reopened"}`);
      return;
    }
    case "comment": {
      await call("POST", `${root}/${number}/comments`, { body: flags.body ?? (await readStdin()) });
      console.log("Commented.");
      return;
    }
    default: {
      // Only summary is left; the checks at the top allow no other action.
      console.log((await call("POST", `${root}/${number}/summary`)).summary);
    }
  }
}

const STATES = new Set(["pending", "success", "failure", "error"]);

async function status([action, sha, state], flags) {
  if (action === "set") {
    const usage =
      "wgw status set <sha> <pending|success|failure|error> [--context <name>] [--description <text>] [--url <https url>]";
    required(sha, usage);
    if (!STATES.has(required(state, usage))) {
      fail(`state must be pending, success, failure, or error; got ${state}`);
    }
  } else if (action === "list") {
    required(sha, "wgw status list <sha> [--json]");
  } else {
    fail("usage: wgw status set|list");
  }
  if (!/^[0-9a-fA-F]{40}$/.test(sha)) {
    fail(`expected a full 40-character commit sha, got ${sha}; try $(git rev-parse HEAD)`);
  }
  const path = `${base(flags)}/statuses/${sha}`;
  if (action === "set") {
    const posted = await call("POST", path, {
      state,
      context: flags.context,
      description: flags.description,
      target_url: flags.url,
    });
    console.log(`${posted.state}  ${posted.context}  ${sha.slice(0, 7)}`);
    return;
  }
  const combined = await call("GET", path);
  if (flags.json) {
    return print(combined);
  }
  console.log(`${sha.slice(0, 7)}  ${combined.state ?? "no statuses"}`);
  for (const item of combined.statuses) {
    const details = [item.description, item.target_url].filter(Boolean).join("  ");
    console.log(`  ${item.state.padEnd(8)} ${item.context}${details ? `  ${details}` : ""}`);
  }
}

function showVariables(label, variables) {
  console.log(label);
  for (const variable of variables) {
    console.log(`  ${variable.name}${variable.secret ? " (secret)" : `=${variable.value}`}`);
  }
}

async function env([action, name], flags) {
  if (action === "create") {
    required(name, "wgw env create <name> [--kind production|staging|preview|development]");
  } else if (action === "delete") {
    required(name, "wgw env delete <name>");
  } else if (action !== "list" && action !== "pull") {
    fail("usage: wgw env list|create|delete|pull");
  }
  const root = base(flags);
  if (action === "list") {
    const data = await call("GET", `${root}/environments`);
    showVariables("repository (all environments)", data.repository);
    for (const item of data.environments) {
      showVariables(`${item.name} [${item.kind}]`, item.variables);
    }
    return;
  }
  if (action === "create") {
    return print(await call("POST", `${root}/environments`, { name, kind: flags.kind }));
  }
  if (action === "delete") {
    await call("DELETE", `${root}/environments/${encodeURIComponent(name)}`);
    console.log(`Deleted ${name}`);
    return;
  }
  const query = new URLSearchParams({
    environment: name ?? "",
    format: flags.json ? "json" : "dotenv",
  });
  process.stdout.write(await call("GET", `${root}/env?${query}`, undefined, { raw: true }));
}

async function secret([action, name, value], flags) {
  if (action === "set") {
    required(name, "wgw secret set <NAME> [--env <name>] [--plain] [<value>]");
  } else if (action === "delete") {
    required(name, "wgw secret delete <NAME> [--env <name>]");
  } else {
    fail("usage: wgw secret set|delete");
  }
  const root = base(flags);
  if (action === "set") {
    const resolved = value ?? (await readStdin());
    await call("PUT", `${root}/variables/${encodeURIComponent(name)}`, {
      value: resolved,
      secret: !flags.plain,
      environment: flags.env ?? "",
    });
    console.log(`Set ${name}${flags.env ? ` in ${flags.env}` : " for the repository"}`);
    return;
  }
  await call(
    "DELETE",
    `${root}/variables/${encodeURIComponent(name)}?environment=${encodeURIComponent(flags.env ?? "")}`,
  );
  console.log(`Deleted ${name}`);
}

async function key([action, name], flags) {
  if (action === "create") {
    required(
      name,
      "wgw key create <name> [--scopes read,write,admin,secrets] [--repo owner/name] [--env <name>] [--days 90]",
    );
    const created = await call("POST", "/api/keys", {
      name,
      scopes: flags.scopes?.split(","),
      repo: flags.repo,
      environment: flags.env,
      expires_in_days: flags.days === undefined ? undefined : Number(flags.days),
    });
    console.log(created.token);
    return;
  }
  if (action === "list") {
    for (const item of await call("GET", "/api/keys")) {
      const limits = [
        item.repo_id === null ? "" : ` repo:${item.repo ?? "(deleted)"}`,
        item.environment ? ` env:${item.environment}` : "",
        item.expires_at === null
          ? " no expiry"
          : ` expires ${new Date(item.expires_at * 1000).toISOString().slice(0, 10)}`,
      ].join("");
      console.log(`${item.id}  ${item.prefix}…  ${item.name}  [${item.scopes.join(",")}]${limits}`);
    }
    return;
  }
  if (action === "revoke") {
    required(name, "wgw key revoke <id>");
    await call("DELETE", `/api/keys/${encodeURIComponent(name)}`);
    console.log(`Revoked ${name}`);
    return;
  }
  fail("usage: wgw key create|list|revoke");
}

async function collab([action, handle], flags) {
  if (action === "add") {
    required(handle, "wgw collab add <handle> [--role read|write|admin]");
  } else if (action === "remove") {
    required(handle, "wgw collab remove <handle>");
  } else if (action !== "list") {
    fail("usage: wgw collab list|add|remove");
  }
  const root = `${base(flags)}/collaborators`;
  if (action === "list") {
    for (const item of await call("GET", root)) {
      console.log(`@${item.handle}  ${item.role}`);
    }
    return;
  }
  if (action === "add") {
    return print(
      await call("PUT", `${root}/${encodeURIComponent(handle)}`, { role: flags.role ?? "write" }),
    );
  }
  await call("DELETE", `${root}/${encodeURIComponent(handle)}`);
  console.log(`Removed @${handle}`);
}

function showDelivery(item) {
  const status = item.status === null ? "no response" : String(item.status);
  const note = item.error === null ? "" : `  ${item.error}`;
  console.log(
    `${item.id}  ${item.event}  ${status}  ${item.duration_ms} ms  ${ago(item.created_at)}${note}`,
  );
}

async function hook([action, target], flags) {
  if (action === "create") {
    required(target, "wgw hook create <https url> [--events push,pull_request]");
  } else if (action === "delete" || action === "ping" || action === "deliveries") {
    required(target, `wgw hook ${action} <id>`);
  } else if (action !== "list") {
    fail("usage: wgw hook list|create|delete|ping|deliveries");
  }
  const root = `${base(flags)}/hooks`;
  if (action === "list") {
    for (const item of await call("GET", root)) {
      const last =
        item.last_delivery_at === null
          ? "never delivered"
          : `last ${item.last_status ?? "no response"} ${ago(item.last_delivery_at)}`;
      console.log(
        `${item.id}  ${item.url}  [${item.events.join(",")}]  ${item.active ? "" : "paused  "}${last}`,
      );
    }
    return;
  }
  if (action === "create") {
    const created = await call("POST", root, { url: target, events: flags.events?.split(",") });
    console.log(`Created ${created.id} for ${created.url}`);
    console.log(`Signing secret (shown once): ${created.secret}`);
    return;
  }
  const path = `${root}/${encodeURIComponent(target)}`;
  if (action === "ping") {
    return showDelivery(await call("POST", `${path}/ping`));
  }
  if (action === "deliveries") {
    for (const item of await call("GET", `${path}/deliveries`)) {
      showDelivery(item);
    }
    return;
  }
  await call("DELETE", path);
  console.log(`Deleted ${target}`);
}

// Any error left, like a network failure or bad JSON, prints one line instead of a stack trace.
try {
  await main();
} catch (error) {
  const cause = error?.cause instanceof Error ? `: ${error.cause.message}` : "";
  fail(`${error instanceof Error ? error.message : String(error)}${cause}`);
}
