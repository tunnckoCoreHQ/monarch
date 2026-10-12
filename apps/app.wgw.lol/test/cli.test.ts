import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { utf8 } from "../src/git/bytes";
import { isService } from "../src/git/protocol";
import type { GitRepo } from "../src/git/repo";
import { memoryRepo } from "./memory";

// The wgw CLI runs as a child process against a local server that plays app.wgw.lol: the API
// paths answer from `routes`, and the git paths serve one repository to the key TOKEN only.
const WGW = join(import.meta.dirname, "../public/wgw.mjs");
const TOKEN = "wgw_testkey0123456789";
const person = { name: "Tester", email: "t@example.com", time: 1_760_000_000, tz: "+0000" };

interface Reply {
  status: number;
  json?: unknown;
}

let repo: GitRepo;
let server: Server;
let base: string;
let home: string;
let routes: Record<string, () => Reply>;
let requests: Array<{ route: string; authorization?: string }>;
const root = mkdtempSync(join(tmpdir(), "wgw-cli-"));

async function serveGit(url: URL, method: string, body: Uint8Array) {
  if (method === "GET" && url.pathname.endsWith("/info/refs")) {
    const service = url.searchParams.get("service");
    if (!isService(service)) {
      return { status: 400, type: "text/plain", body: new Uint8Array() };
    }
    return {
      status: 200,
      type: `application/x-${service}-advertisement`,
      body: repo.advertise(service, "full"),
    };
  }
  if (url.pathname.endsWith("/git-upload-pack")) {
    return {
      status: 200,
      type: "application/x-git-upload-pack-result",
      body: await repo.uploadPack(body, "full"),
    };
  }
  const { response } = await repo.receivePack(body);
  return { status: 200, type: "application/x-git-receive-pack-result", body: response };
}

async function respond(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    const route = `${req.method} ${url.pathname}`;
    requests.push({ route, authorization: req.headers.authorization });
    const reply = routes[route]?.() ?? { status: 404, json: { message: "not found" } };
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.json ?? {}));
    return;
  }
  if (req.headers.authorization !== `Basic ${btoa(`x:${TOKEN}`)}`) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="wgw"' });
    res.end();
    return;
  }
  const out = await serveGit(url, req.method ?? "GET", new Uint8Array(body));
  res.writeHead(out.status, { "content-type": out.type, "cache-control": "no-cache" });
  res.end(Buffer.from(out.body));
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command with HOME, the git config, and the wgw config inside the test's home. */
function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Run> {
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Tester",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "Tester",
    GIT_COMMITTER_EMAIL: "t@example.com",
    WGW_HOST: base,
    ...options.env,
  };
  return new Promise((resolve) => {
    execFile(command, args, { cwd: options.cwd ?? home, env }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : (error.code as number), stdout, stderr });
    });
  });
}

const wgw = (args: string[], options?: Parameters<typeof run>[2]) =>
  run("node", [WGW, ...args], options);

const configPath = () => join(home, ".config", "wgw", "config.json");

function storeConfig(config: Record<string, string>) {
  mkdirSync(join(home, ".config", "wgw"), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config));
}

beforeAll(async () => {
  repo = memoryRepo();
  repo.commitFiles("main", undefined, "start", person, [
    { path: "README.md", content: utf8("# hello\n") },
  ]);
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      respond(req, res, Buffer.concat(chunks)).catch((error: unknown) =>
        res.destroy(error instanceof Error ? error : undefined),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  home = mkdtempSync(join(root, "home-"));
  routes = {};
  requests = [];
});

afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("wgw clone", () => {
  it("sends WGW_TOKEN without wgw login and keeps it out of the clone", async () => {
    // A helper from git config that answers with a wrong password must not get a say.
    writeFileSync(
      join(home, ".gitconfig"),
      `[credential "${base}"]\n\thelper = "!f() { echo username=x; echo password=wrong; }; f"\n`,
    );
    const cloned = await wgw(["clone", "alice/r", "out"], { env: { WGW_TOKEN: TOKEN } });
    expect(cloned.code).toBe(0);
    expect(readFileSync(join(home, "out", "README.md"), "utf-8")).toBe("# hello\n");
    expect(cloned.stdout + cloned.stderr).not.toContain(TOKEN);
    const config = readFileSync(join(home, "out", ".git", "config"), "utf-8");
    expect(config).toContain(`url = ${base}/alice/r.git`);
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain("credential");
  });

  it("sends the stored key, and a later git push works through the setup-git helper", async () => {
    storeConfig({ token: TOKEN });
    expect((await wgw(["clone", "alice/r", "out"])).code).toBe(0);
    const out = join(home, "out");
    writeFileSync(join(out, "a.txt"), "a\n");
    await run("git", ["add", "a.txt"], { cwd: out });
    await run("git", ["commit", "-q", "-m", "add a"], { cwd: out });
    // The clone keeps no credentials of its own, so git needs the helper that setup-git writes.
    const refused = await run("git", ["push", "-q", "origin", "main"], { cwd: out });
    expect(refused.code).not.toBe(0);
    expect((await wgw(["setup-git"])).code).toBe(0);
    const pushed = await run("git", ["push", "-q", "origin", "main"], { cwd: out });
    expect(pushed).toMatchObject({ code: 0 });
    expect(repo.log("full", "main")[0].message.trim()).toBe("add a");
  });
});

describe("wgw logout", () => {
  it("revokes the key by the id that login stored", async () => {
    storeConfig({ token: TOKEN, token_id: "tok_1", handle: "alice" });
    routes["DELETE /api/keys/tok_1"] = () => ({ status: 200, json: { ok: true } });
    const out = await wgw(["logout"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("Revoked the stored key");
    expect(requests).toEqual([
      { route: "DELETE /api/keys/tok_1", authorization: `Bearer ${TOKEN}` },
    ]);
    expect(existsSync(configPath())).toBe(false);
  });

  it("finds a key stored without an id by its prefix", async () => {
    storeConfig({ token: TOKEN });
    routes["GET /api/keys"] = () => ({
      status: 200,
      json: [
        { id: "tok_other", prefix: "wgw_otherkey" },
        { id: "tok_2", prefix: TOKEN.slice(0, 12) },
      ],
    });
    routes["DELETE /api/keys/tok_2"] = () => ({ status: 200, json: { ok: true } });
    expect((await wgw(["logout"])).code).toBe(0);
    expect(requests.map((request) => request.route)).toEqual([
      "GET /api/keys",
      "DELETE /api/keys/tok_2",
    ]);
    expect(existsSync(configPath())).toBe(false);
  });

  it("deletes the config file and says why when the revoke fails", async () => {
    storeConfig({ token: TOKEN });
    routes["GET /api/keys"] = () => ({
      status: 403,
      json: { message: "a limited key cannot manage keys" },
    });
    const out = await wgw(["logout"]);
    expect(out.code).toBe(0);
    expect(out.stderr).toContain("could not revoke the key on the server: 403 a limited key");
    expect(out.stderr).not.toContain(TOKEN);
    expect(existsSync(configPath())).toBe(false);
  });

  it("says that WGW_TOKEN stays set when no key is stored", async () => {
    const out = await wgw(["logout"], { env: { WGW_TOKEN: TOKEN } });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("No key is stored.");
    expect(out.stdout).toContain("WGW_TOKEN is still set");
    expect(requests).toEqual([]);
  });
});

describe("relative times", () => {
  it("counts seconds as seconds and rounds down", async () => {
    routes["GET /api/repos/alice/r/hooks/wh_1/deliveries"] = () => ({
      status: 200,
      json: [5, 90, 3600 * 2 + 50 * 60].map((age, i) => ({
        id: `del_${i}`,
        event: "ping",
        status: 200,
        error: null,
        duration_ms: 12,
        created_at: Math.floor(Date.now() / 1000) - age,
      })),
    });
    const out = await wgw(["hook", "deliveries", "wh_1", "-R", "alice/r"], {
      env: { WGW_TOKEN: TOKEN },
    });
    expect(out.code).toBe(0);
    expect(out.stdout.trim().split("\n")).toEqual([
      "del_0  ping  200  12 ms  just now",
      "del_1  ping  200  12 ms  1m ago",
      "del_2  ping  200  12 ms  2h ago",
    ]);
  });
});
