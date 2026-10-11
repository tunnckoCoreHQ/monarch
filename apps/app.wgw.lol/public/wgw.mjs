#!/usr/bin/env node
// wgw: the command line for app.wgw.lol. One file, no dependencies, Node 20+ or Bun.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
  wgw repo fork <owner/name> [--name <new>]
  wgw repo delete <owner/name> --yes
  wgw clone <owner/name> [dir]   members get the private paths too

Direct Artifacts access
  wgw repo token [owner/name] [--write] [--json]   a 1-hour token for the Artifacts git remote
  eval "$(wgw repo token)"       sets WGW_GIT_REMOTE and WGW_GIT_TOKEN in this shell

Files without a clone
  wgw ls [path] [--ref <ref>]    wgw cat <path> [--ref <ref>]    wgw log [--ref <ref>]
  wgw commit --branch <b> -m <message> <repo/path=local/file>... [--delete <path>]

Search
  wgw search "<query>" [-R owner/name] [--json]   code by meaning; outside a clone, all public repositories

Pull requests
  wgw pr create --head <branch> [--base <branch>] --title <text> [--body <text>]
  wgw pr list [--state open|merged|closed|all]
  wgw pr view <n> | diff <n> | merge <n> | close <n> | reopen <n> | summary <n>
  wgw pr comment <n> --body <text>

Environments and secrets
  wgw env list | env create <name> [--kind production|staging|preview|development] | env delete <name>
  wgw secret set <NAME> [--env <name>] [--plain] [<value>]   (reads stdin without a value)
  wgw secret delete <NAME> [--env <name>]
  wgw env pull [<name>] [--json]  prints dotenv lines, repository values first

Access
  wgw key create <name> [--scopes read,write,admin,secrets] [--repo owner/name] [--env <name>] [--days 90]
  wgw key list | key revoke <id>
  wgw collab list | collab add <handle> [--role read|write|admin] | collab remove <handle>

Other
  wgw api <METHOD> <path> [json]   raw API call, prints the response
  -R owner/name                    pick the repository; defaults to the git remote that points at ${new URL(HOST).host}
`;

function fail(message) {
  console.error(`wgw: ${message}`);
  process.exit(1);
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

const BOOLEAN_FLAGS = new Set(["private", "yes", "plain", "json", "write"]);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-R" || arg === "-m") {
      flags[arg === "-R" ? "repo" : "message"] = argv[++i];
    } else if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2);
      const next = argv[i + 1];
      if (inline !== undefined) {
        flags[name] = inline;
      } else if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith("-")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** `raw: true` returns the body as text; `raw: "bytes"` returns it as a Buffer. */
async function call(method, path, body, { raw = false, auth = true } = {}) {
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
    fail(`${res.status} ${message}${res.status === 401 ? " (run `wgw login`)" : ""}`);
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

function currentRepo(flags) {
  return detectRepo(flags) ?? fail("no repository: pass -R owner/name or run inside a clone");
}

function base(flags) {
  const repo = currentRepo(flags);
  const [owner, name] = repo.split("/");
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
  const self = process.argv[1];
  const runtime = process.execPath;
  git([
    "config",
    "--global",
    `credential.${host}.helper`,
    `!"${runtime}" "${self}" git-credential`,
  ]);
  // Public repositories answer anonymous requests, so git must send the key up front for members
  // to receive private paths.
  git(["config", "--global", `http.${host}.proactiveAuth`, "basic"]);
}

function git(args) {
  const result = spawnSync("git", args, { stdio: "inherit" });
  if (result.status !== 0) {
    fail(`git ${args[0]} failed`);
  }
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
  const [command, sub, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(sub === undefined ? [] : [sub, ...rest]);
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      console.log(HELP);
      return;
    }
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
      if (positional[0] === "get" && token()) {
        process.stdout.write(`username=x\npassword=${token()}\n`);
      }
      return;
    }
    case "clone": {
      const [repo, dir] = positional;
      if (repo === undefined) {
        fail("usage: wgw clone owner/name [dir]");
      }
      const args = ["-c", "http.proactiveAuth=basic", "clone", `${HOST}/${repo}.git`];
      if (dir !== undefined) {
        args.push(dir);
      }
      return git(args);
    }
    case "repo": {
      return repo(positional, flags);
    }
    case "ls": {
      const query = new URLSearchParams({ path: positional[0] ?? "", ref: flags.ref ?? "" });
      const tree = await call("GET", `${base(flags)}/tree?${query}`);
      for (const item of tree.items) {
        console.log(
          `${item.type === "tree" ? "dir " : "file"}  ${item.path}${item.type === "tree" ? "/" : ""}`,
        );
      }
      return;
    }
    case "cat": {
      const query = new URLSearchParams({ path: positional[0] ?? "", ref: flags.ref ?? "" });
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
      const files = positional.map((spec) => {
        const [path, local] = spec.split("=");
        if (local === undefined) {
          fail(`expected repo/path=local/file, got ${spec}`);
        }
        return { path, content: readFileSync(local).toString("base64"), encoding: "base64" };
      });
      if (typeof flags.delete === "string") {
        files.push({ path: flags.delete, delete: true });
      }
      const result = await call("POST", `${base(flags)}/commits`, {
        branch: flags.branch,
        message: flags.message,
        files,
      });
      console.log(`${result.sha}  ${result.branch}`);
      return;
    }
    case "search": {
      return search(positional[0], flags);
    }
    case "pr": {
      return pr(positional, flags);
    }
    case "env": {
      return env(positional, flags);
    }
    case "secret": {
      return secret(positional, flags);
    }
    case "key": {
      return key(positional, flags);
    }
    case "collab": {
      return collab(positional, flags);
    }
    case "api": {
      const [method, path, json] = positional;
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
  const root = base(target === undefined ? flags : { repo: target });
  const grant = await call("POST", `${root}/git-token`, { scope });
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
    const branch = flags["import-branch"];
    if (branch === true) {
      fail("--import-branch needs a branch name");
    }
    if (branch !== undefined && !flags.import) {
      fail("--import-branch needs --import <https url>");
    }
    const created = await call("POST", "/api/repos", {
      name: target,
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
    const item = await call("GET", base(target === undefined ? flags : { repo: target }));
    return flags.json ? print(item) : showRepo(item);
  }
  if (action === "token") {
    return gitToken(target, flags);
  }
  if (action === "fork") {
    const forked = await call("POST", `${base({ repo: target })}/fork`, { name: flags.name });
    console.log(forked.clone_url);
    if (forked.status === "forking") {
      console.log(`Forking. Run \`wgw repo view ${forked.full_name}\` until the status is ready.`);
    }
    return;
  }
  if (action === "delete") {
    if (!flags.yes) {
      fail("pass --yes to delete");
    }
    await call("DELETE", base({ repo: target }));
    console.log(`Deleted ${target}`);
    return;
  }
  fail("usage: wgw repo create|list|view|token|fork|delete");
}

/** Searches one repository, or every public repository when there is none to pick. */
async function search(query, flags) {
  if (query === undefined || query.trim() === "") {
    fail('usage: wgw search "<query>" [-R owner/name] [--json]');
  }
  const repo = detectRepo(flags);
  const params = new URLSearchParams({ q: query, limit: flags.limit ?? "10" });
  const path = repo === undefined ? "/api/search" : `${base({ repo })}/search`;
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

async function pr([action, number], flags) {
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
    case "summary": {
      console.log((await call("POST", `${root}/${number}/summary`)).summary);
      return;
    }
    default: {
      fail("usage: wgw pr create|list|view|diff|merge|close|reopen|comment|summary");
    }
  }
}

function showVariables(label, variables) {
  console.log(label);
  for (const variable of variables) {
    console.log(`  ${variable.name}${variable.secret ? " (secret)" : `=${variable.value}`}`);
  }
}

async function env([action, name], flags) {
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
  if (action === "pull") {
    const query = new URLSearchParams({
      environment: name ?? "",
      format: flags.json ? "json" : "dotenv",
    });
    process.stdout.write(await call("GET", `${root}/env?${query}`, undefined, { raw: true }));
    return;
  }
  fail("usage: wgw env list|create|delete|pull");
}

async function secret([action, name, value], flags) {
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
  if (action === "delete") {
    await call(
      "DELETE",
      `${root}/variables/${encodeURIComponent(name)}?environment=${encodeURIComponent(flags.env ?? "")}`,
    );
    console.log(`Deleted ${name}`);
    return;
  }
  fail("usage: wgw secret set|delete");
}

async function key([action, name], flags) {
  if (action === "create") {
    const created = await call("POST", "/api/keys", {
      name,
      scopes: typeof flags.scopes === "string" ? flags.scopes.split(",") : undefined,
      repo: flags.repo,
      environment: flags.env,
      expires_in_days: flags.days === undefined ? undefined : Number(flags.days),
    });
    console.log(created.token);
    return;
  }
  if (action === "list") {
    for (const item of await call("GET", "/api/keys")) {
      console.log(
        `${item.id}  ${item.prefix}…  ${item.name}  [${item.scopes.join(",")}]${item.environment ? ` env:${item.environment}` : ""}`,
      );
    }
    return;
  }
  if (action === "revoke") {
    await call("DELETE", `/api/keys/${encodeURIComponent(name)}`);
    console.log(`Revoked ${name}`);
    return;
  }
  fail("usage: wgw key create|list|revoke");
}

async function collab([action, handle], flags) {
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
  if (action === "remove") {
    await call("DELETE", `${root}/${encodeURIComponent(handle)}`);
    console.log(`Removed @${handle}`);
    return;
  }
  fail("usage: wgw collab list|add|remove");
}

await main();
