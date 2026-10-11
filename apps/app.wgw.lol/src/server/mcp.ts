import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { FileDiff } from "../git/diff";
import type { AppContext } from "./auth";
import { NAME_PATTERN } from "./util";

// The remote MCP server at /mcp: Streamable HTTP in stateless mode, one server per request. Each
// tool sends a request through the whole Hono app with the caller's credential, so the API's
// scopes, access rules, private paths, and key limits apply unchanged.

/** Runs a request through the Hono app. */
export type Dispatch = (request: Request) => Response | Promise<Response>;

/** The JSON API, called as the MCP caller. Paths start after /api. */
interface Api {
  get(path: string, query?: Record<string, string | number | undefined>): Promise<Response>;
  post(path: string, body: unknown): Promise<Response>;
}

const INSTRUCTIONS = `wgw is git hosting at https://app.wgw.lol. Repositories are owner/name. Members see every file; everyone else sees the public projection, which leaves out the paths listed in .gitprivate.
Without a token you get the read tools, on public repositories only. Send a wgw API key or an auth.md access token as "Authorization: Bearer <token>" to get the write tools; the key's scopes and repository limit still apply.
Docs: https://app.wgw.lol/skill.md`;

// Owner and name go into the API path. The pattern keeps "/" and ".." out of them.
const OWNER = z.string().regex(NAME_PATTERN).describe("Owner handle, such as alice");
const NAME = z.string().regex(NAME_PATTERN).describe("Repository name");
const REPO = { owner: OWNER, name: NAME };
const REF = z
  .string()
  .optional()
  .describe("Branch, tag, or commit SHA. Defaults to the default branch.");
const NUMBER = z.number().int().positive().describe("Pull request number");
const READ_ONLY = { readOnlyHint: true };

function repoPath(repo: { owner: string; name: string }): string {
  return `/repos/${repo.owner}/${repo.name}`;
}

function text(value: string) {
  return { type: "text" as const, text: value };
}

/** The API answer as a tool result. A failure keeps the status and the API's error body. */
async function result(pending: Response | Promise<Response>): Promise<CallToolResult> {
  const response = await pending;
  const body = await response.text();
  return response.ok
    ? { content: [text(body)] }
    : { isError: true, content: [text(`${response.status} ${body}`)] };
}

/** Tools for every caller. Without a token the API shows public repositories and paths only. */
function readTools(server: McpServer, api: Api): void {
  server.registerTool(
    "whoami",
    {
      description: "Show the account and scopes of the current token.",
      annotations: READ_ONLY,
    },
    () => result(api.get("/me")),
  );
  server.registerTool(
    "list_repos",
    {
      description:
        "List the repositories you can see, most recently pushed first, optionally for one owner.",
      inputSchema: { owner: OWNER.optional() },
      annotations: READ_ONLY,
    },
    ({ owner }) => result(api.get("/repos", { owner })),
  );
  server.registerTool(
    "get_repo",
    {
      description:
        "Get a repository with its branches, tags, open pull request count, and your role.",
      inputSchema: REPO,
      annotations: READ_ONLY,
    },
    (args) => result(api.get(repoPath(args))),
  );
  server.registerTool(
    "list_tree",
    {
      description: "List the files and directories in one directory of a repository at a ref.",
      inputSchema: {
        ...REPO,
        path: z.string().optional().describe("Directory path, such as src. Defaults to the root."),
        ref: REF,
      },
      annotations: READ_ONLY,
    },
    (args) => result(api.get(`${repoPath(args)}/tree`, { ref: args.ref, path: args.path })),
  );
  server.registerTool(
    "read_file",
    {
      description:
        "Read a file at a ref. Returns its text, size, blob SHA, and the commit the ref resolved to; binary files and files over 1 MB have no text.",
      inputSchema: {
        ...REPO,
        path: z.string().describe("File path, such as src/index.ts"),
        ref: REF,
      },
      annotations: READ_ONLY,
    },
    (args) => result(api.get(`${repoPath(args)}/blob`, { ref: args.ref, path: args.path })),
  );
  server.registerTool(
    "search_code",
    {
      description:
        "Search code by meaning at the default branch tip of one repository, or of every public repository when owner and name are left out.",
      inputSchema: {
        query: z.string().min(1).describe("What the code does, in plain words"),
        owner: OWNER.optional(),
        name: NAME.optional(),
        limit: z.number().int().min(1).max(50).optional().describe("1 to 50, default 10"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, owner, name, limit }) => {
      if (owner === undefined || name === undefined) {
        if (owner !== name) {
          return { isError: true, content: [text("pass both owner and name, or neither")] };
        }
        return result(api.get("/search", { q: query, limit }));
      }
      return result(api.get(`${repoPath({ owner, name })}/search`, { q: query, limit }));
    },
  );
  server.registerTool(
    "list_commits",
    {
      description:
        "List the commits on a ref, newest first, optionally only those that touch a path.",
      inputSchema: {
        ...REPO,
        ref: REF,
        path: z.string().optional().describe("Only commits that change this path"),
        limit: z.number().int().min(1).max(200).optional().describe("1 to 200, default 30"),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      result(
        api.get(`${repoPath(args)}/commits`, {
          ref: args.ref,
          path: args.path,
          limit: args.limit,
        }),
      ),
  );
  server.registerTool(
    "get_commit",
    {
      description: "Get one commit with its message, author, parents, and the diff of each file.",
      inputSchema: { ...REPO, sha: z.string().min(1).describe("Commit SHA") },
      annotations: READ_ONLY,
    },
    (args) => result(api.get(`${repoPath(args)}/commits/${encodeURIComponent(args.sha)}`)),
  );
  server.registerTool(
    "compare",
    {
      description:
        "Compare two refs: the commits on head that base lacks, the diff of each file, and whether head merges cleanly into base.",
      inputSchema: {
        ...REPO,
        base: REF,
        head: z.string().min(1).describe("Branch, tag, or commit SHA to compare with base"),
      },
      annotations: READ_ONLY,
    },
    (args) => result(api.get(`${repoPath(args)}/compare`, { base: args.base, head: args.head })),
  );
  server.registerTool(
    "list_pulls",
    {
      description: "List the pull requests of a repository, newest first.",
      inputSchema: {
        ...REPO,
        state: z.enum(["open", "closed", "merged", "all"]).optional().describe("Default open"),
      },
      annotations: READ_ONLY,
    },
    (args) => result(api.get(`${repoPath(args)}/pulls`, { state: args.state })),
  );
  server.registerTool(
    "get_pull",
    {
      description:
        "Get a pull request with its commits, changed files, mergeability, and the unified diff.",
      inputSchema: { ...REPO, number: NUMBER },
      annotations: READ_ONLY,
    },
    async (args) => {
      const response = await api.get(`${repoPath(args)}/pulls/${args.number}`);
      if (!response.ok) {
        return result(response);
      }
      // A closed pull request has no compare. A compare that failed holds only the error.
      const pull: { compare: { files?: FileDiff[] } | null } = await response.json();
      const compare = pull.compare;
      if (compare === null || compare.files === undefined) {
        return { content: [text(JSON.stringify(pull))] };
      }
      // The patches move out of the JSON into one unified diff, joined the way GET …/diff does.
      const files = compare.files.map(({ patch: _patch, ...file }) => file);
      return {
        content: [
          text(JSON.stringify({ ...pull, compare: { ...compare, files } })),
          text(compare.files.map((file) => file.patch).join("")),
        ],
      };
    },
  );
  server.registerTool(
    "get_git_token",
    {
      description:
        "Get a one-hour Artifacts git remote and token, to clone (or with scope write, push) without going through app.wgw.lol.",
      inputSchema: {
        ...REPO,
        scope: z
          .enum(["read", "write"])
          .optional()
          .describe("Default read. Write needs write access and a key with the write scope."),
      },
    },
    (args) => result(api.post(`${repoPath(args)}/git-token`, { scope: args.scope })),
  );
}

/** Tools that change something or open secrets. Only callers with a token get them. */
function writeTools(server: McpServer, api: Api): void {
  server.registerTool(
    "create_repo",
    {
      description:
        "Create a repository under your account, empty or imported from an https git remote.",
      inputSchema: {
        name: z.string().describe("1 to 100 letters, digits, dots, dashes, or underscores"),
        description: z.string().optional(),
        visibility: z.enum(["public", "private"]).optional().describe("Default public"),
        import_url: z
          .string()
          .optional()
          .describe("An https:// git remote; wgw imports its default branch"),
      },
    },
    (args) => result(api.post("/repos", args)),
  );
  server.registerTool(
    "create_branch",
    {
      description: "Create a branch from a branch, tag, or commit.",
      inputSchema: {
        ...REPO,
        branch: z.string().min(1).describe("New branch name"),
        from: REF,
      },
    },
    (args) =>
      result(api.post(`${repoPath(args)}/branches`, { name: args.branch, from: args.from })),
  );
  server.registerTool(
    "commit_files",
    {
      description:
        "Commit file changes to a branch without a clone, and create the branch when it does not exist.",
      inputSchema: {
        ...REPO,
        branch: z.string().optional().describe("Defaults to the default branch"),
        message: z.string().min(1).describe("Commit message"),
        files: z
          .array(
            z.object({
              path: z.string().describe("File path from the repository root"),
              content: z.string().optional().describe("The new file content"),
              encoding: z
                .enum(["utf-8", "base64"])
                .optional()
                .describe("Encoding of content, default utf-8"),
              delete: z.boolean().optional().describe("True to delete the file"),
              mode: z
                .enum(["100644", "100755", "120000"])
                .optional()
                .describe(
                  "File mode: 100644 regular, 100755 executable, 120000 symlink; defaults to the existing mode or 100644",
                ),
            }),
          )
          .min(1),
        expected_sha: z
          .string()
          .optional()
          .describe("The branch tip you expect. The commit fails with 409 if the branch moved."),
      },
    },
    (args) =>
      result(
        api.post(`${repoPath(args)}/commits`, {
          branch: args.branch,
          message: args.message,
          files: args.files,
          expected_sha: args.expected_sha,
        }),
      ),
  );
  server.registerTool(
    "open_pull",
    {
      description: "Open a pull request from a head branch into a base branch.",
      inputSchema: {
        ...REPO,
        title: z.string().min(1),
        head: z.string().min(1).describe("Branch with the changes"),
        base: z.string().optional().describe("Target branch. Defaults to the default branch."),
        body: z.string().optional().describe("Description in Markdown"),
      },
    },
    (args) =>
      result(
        api.post(`${repoPath(args)}/pulls`, {
          title: args.title,
          head: args.head,
          base: args.base,
          body: args.body,
        }),
      ),
  );
  server.registerTool(
    "comment_pull",
    {
      description: "Add a comment to a pull request.",
      inputSchema: { ...REPO, number: NUMBER, body: z.string().min(1).describe("Markdown") },
    },
    (args) =>
      result(api.post(`${repoPath(args)}/pulls/${args.number}/comments`, { body: args.body })),
  );
  server.registerTool(
    "merge_pull",
    {
      description:
        "Merge an open pull request on the server: a fast-forward when possible, else a merge commit. Fails with 409 on conflicts.",
      inputSchema: {
        ...REPO,
        number: NUMBER,
        message: z.string().optional().describe("Merge commit message"),
      },
    },
    (args) =>
      result(api.post(`${repoPath(args)}/pulls/${args.number}/merge`, { message: args.message })),
  );
  server.registerTool(
    "pull_env",
    {
      description:
        "Needs a key with the secrets scope and write access. Returns the decrypted variables and secrets of one environment; the repository activity logs each read.",
      inputSchema: {
        ...REPO,
        environment: z
          .string()
          .optional()
          .describe(
            "Environment name, such as production. Without it, repository-wide values only.",
          ),
      },
    },
    (args) => result(api.get(`${repoPath(args)}/env`, { environment: args.environment })),
  );
}

export async function handleMcp(c: AppContext, dispatch: Dispatch): Promise<Response> {
  if (c.req.method !== "POST") {
    // Stateless: the server never sends messages of its own, so there is no stream to GET.
    return c.json({ error: "method_not_allowed", message: "send MCP messages with POST" }, 405, {
      allow: "POST",
    });
  }
  // The tools send only the bearer token and the client address, never a session cookie.
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of ["authorization", "cf-connecting-ip"]) {
    const value = c.req.header(name);
    if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const api: Api = {
    get: async (path, query = {}) => {
      const url = new URL(`/api${path}`, c.env.ORIGIN);
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
      return dispatch(new Request(url, { headers }));
    },
    post: async (path, body) =>
      dispatch(
        new Request(new URL(`/api${path}`, c.env.ORIGIN), {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      ),
  };
  const server = new McpServer(
    { name: "wgw", version: c.env.COMMIT_SHA },
    { instructions: INSTRUCTIONS },
  );
  readTools(server, api);
  if (c.get("principal")?.via === "token") {
    writeTools(server, api);
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
}
