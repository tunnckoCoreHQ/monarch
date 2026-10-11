---
name: wgw-git
description: Host, clone, push, review, and merge git repositories on app.wgw.lol, a git platform that runs on Cloudflare. Use it to create repositories, open and merge pull requests, commit files over HTTP without a clone, search code by meaning, keep private paths inside a public repository, read deployment secrets for an environment, and get a short-lived token for the Artifacts git remote.
---

# wgw git hosting

app.wgw.lol is plain git over HTTPS plus a JSON API. There is no GitHub underneath.

- Web: `https://app.wgw.lol`
- Git remote: `https://app.wgw.lol/<owner>/<repo>.git`
- API base: `https://app.wgw.lol/api`
- Agent registration: `https://app.wgw.lol/auth.md`

Git storage is Cloudflare Artifacts. Each wgw repository is two Artifacts repositories:

- The full repository. Members clone and push here.
- The public projection, the same history without the `.gitprivate` paths. Everyone else reads this one. Only wgw writes to it.

The clone URL stays on app.wgw.lol. wgw checks who you are and forwards git to the right Artifacts repository. A Durable Object per repository keeps a mirror of the full repository. It builds the public projection, runs merges and API commits, and pushes the results to Artifacts. The web view and the API read from the mirror.

## 1. Get a token

Pick the first option that fits.

1. **A person gives you a key.** They create one at `https://app.wgw.lol/settings`, or run `wgw key create my-agent --scopes read,write --repo owner/repo`. Keys can be limited to one repository and one environment. A limited key cannot create, list, or revoke keys.
2. **The CLI device flow.** Run `wgw login`. It prints a URL and a code. A signed-in person (or an agent with an AgentID session) approves it. The CLI stores a 90-day key in `~/.config/wgw/config.json`.
3. **AgentID.** If you own an AgentMail inbox, open `https://app.wgw.lol/auth/agentid/start?login_hint=<inbox>` in your browser. You get an agent account and a browser session; then approve a `wgw login` code with it.
4. **auth.md.** Register yourself with no prior credentials. Follow `https://app.wgw.lol/auth.md`. Before a person claims you, you can read public repositories. After the claim, you act as that person with `read write` scopes for one hour per access token.

Send the token as `Authorization: Bearer <token>`. Git sends it as the HTTP basic password; the username is ignored.

## 2. Install the CLI (optional)

```sh
curl -fsSL https://app.wgw.lol/install.sh | sh
wgw login            # or: wgw login --token "$WGW_TOKEN"
```

The CLI is one file with no dependencies. It needs Node 20+ or Bun. `WGW_TOKEN` overrides the stored key. Every command takes `-R owner/repo`; inside a clone it reads the git remote.

## 3. MCP

The remote MCP server at `https://app.wgw.lol/mcp` uses Streamable HTTP and keeps no session. Claude Code, Cursor, and other MCP clients get the API as tools.

```sh
claude mcp add --transport http wgw https://app.wgw.lol/mcp --header "Authorization: Bearer $WGW_TOKEN"
```

Other clients take the same URL and header. The token is a wgw API key or an auth.md access token. Each tool calls the API with it, so the key's scopes, its repository limit, and `.gitprivate` apply as they do over the API. Without a token you get only the read tools, and they see public repositories and public paths. An invalid or expired token gets 401 with a `WWW-Authenticate` header that points at `/.well-known/oauth-protected-resource`.

- For everyone: `whoami`, `list_repos`, `get_repo`, `list_tree`, `read_file`, `search_code`, `list_commits`, `get_commit`, `compare`, `list_pulls`, `get_pull` (with the unified diff), and `get_git_token`.
- With a token: `create_repo`, `create_branch`, `commit_files`, `open_pull`, `comment_pull`, `merge_pull`, and `pull_env`. The `pull_env` tool opens secrets, so it needs write access and a key with the `secrets` scope.

## 4. Git

```sh
wgw repo create demo                 # public; add --private for a private repository
git remote add wgw https://app.wgw.lol/<you>/demo.git
git push wgw main

wgw clone owner/repo                 # members get private paths too
```

Without the CLI:

```sh
git -c http.proactiveAuth=basic clone "https://x:${WGW_TOKEN}@app.wgw.lol/owner/repo.git"
```

Use `http.proactiveAuth=basic`. Public repositories answer anonymous requests, so plain git never sends your token and you get the public view. `wgw login` and `wgw setup-git` set it for app.wgw.lol for you.

Supported: clone, fetch, pull, push, force push, shallow clones and deeper fetches (`--depth`, `--unshallow`), tags, branch deletes, atomic pushes. Partial clones (`--filter`) are not. When the branch moved after your fetch, the push fails with `fetch first`.

## 5. Direct Artifacts access

You do not need this for normal work. A direct token lets a tool clone or push the Artifacts repository without going through app.wgw.lol.

```sh
eval "$(wgw repo token -R owner/repo)"      # sets WGW_GIT_REMOTE and WGW_GIT_TOKEN
git -c http.extraHeader="Authorization: Bearer $WGW_GIT_TOKEN" clone "$WGW_GIT_REMOTE"

wgw repo token -R owner/repo --write        # a token that can push
wgw repo token -R owner/repo --json         # the raw response
```

Without the CLI:

```sh
curl -s https://app.wgw.lol/api/repos/OWNER/REPO/git-token \
  -H "Authorization: Bearer $WGW_TOKEN" -H 'content-type: application/json' \
  -d '{ "scope": "read" }'
```

```json
{
  "remote": "https://<account>.artifacts.cloudflare.net/git/app-wgw-lol/<name>.git",
  "token": "art_v…",
  "scope": "read",
  "expires_at": "2026-10-11T13:00:00.000Z",
  "view": "full"
}
```

- `scope` is `read` (the default) or `write`.
- Members get the full repository (`"view": "full"`). Everyone else gets the public projection (`"view": "public"`), read only.
- A write token needs write access to the repository and a key with the `write` scope.
- Tokens expire after one hour. Ask for a new one when it runs out.
- The endpoint answers 409 until the repository is `ready`.
- A direct push reaches the web view, the API, and the public projection within a few seconds: Artifacts sends a push event to a Cloudflare Queue, and the app syncs its mirror.

## 6. Commit without a clone

```sh
curl -s https://app.wgw.lol/api/repos/OWNER/REPO/commits \
  -H "Authorization: Bearer $WGW_TOKEN" -H 'content-type: application/json' \
  -d '{
    "branch": "agent/fix-typo",
    "message": "docs: fix a typo",
    "expected_sha": "<current branch tip, or omit>",
    "files": [
      { "path": "README.md", "content": "# Title\n" },
      { "path": "logo.png", "content": "<base64>", "encoding": "base64" },
      { "path": "old.txt", "delete": true }
    ]
  }'
```

The branch is created when it does not exist. With `expected_sha`, the commit fails with 409 when someone else moved the branch first. Use it when several agents work on one branch.

CLI: `wgw commit --branch agent/fix -m "docs: fix" README.md=./README.md`.

## 7. Pull requests

```sh
wgw pr create --head agent/fix-typo --title "Fix a typo" --body "One word."
wgw pr list
wgw pr diff 3          # unified diff, ready for review
wgw pr summary 3       # Workers AI summary of the diff
wgw pr comment 3 --body "Looks right."
wgw pr merge 3         # fast-forward when possible, else a merge commit
```

Merges run on the server. The mirror makes the merge commit and pushes it to Artifacts. A path changed differently on both sides is a conflict; the merge fails with 409 and names the paths. Rebase locally and push again.

## 8. Private paths in a public repository

Add `.gitprivate` at the repository root. The syntax is like `.gitignore`:

```
security/            # a directory
*.pem                # any depth
docs/embargo-*.md    # anchored at the root because it has a slash
```

Members (the owner and collaborators) see everything, over git and over the API. Everyone else sees a public history where those paths never existed. Each commit uses its own `.gitprivate`, so:

- Earlier public commit hashes never change when you add rules later.
- A commit that only touches private paths is left out of the public history.
- Deleting a line publishes that path from the next commit on. This is how a security advisory goes public after the fix ships.
- Commit messages stay visible. Keep embargoed details out of them.

Check what the public sees: `curl -s https://app.wgw.lol/api/repos/OWNER/REPO/tree` without a token.

## 9. Environments and secrets

```sh
wgw env create production --kind production     # kinds: production, staging, preview, development
wgw secret set DATABASE_URL --env production     # reads the value from stdin
wgw secret set LOG_LEVEL --plain info            # repository-wide, not secret
wgw env pull production > .env                   # needs a key with the secrets scope
```

Repository values apply to every environment and environment values override them. Secret values are sealed with AES-256-GCM under a key that belongs to the repository. That key is stored in D1 wrapped by a master key in Cloudflare Secrets Store, and it is deleted with the repository. Only `GET /api/repos/OWNER/REPO/env?environment=NAME` opens them, it needs write access plus the `secrets` scope, and every read is logged in the repository activity.

## 10. Imports and forks

```sh
wgw repo create lib --import https://github.com/owner/lib                    # the default branch
wgw repo create lib-dev --import https://github.com/owner/lib --import-branch dev
wgw repo view you/lib                                                        # status: importing, then ready
```

An import copies one branch: the remote's default branch, or `import_branch` when you give one. Push other branches yourself after the import. Artifacts runs the import. The repository shows `"status": "importing"` until a Workflow sees the import finish and syncs the mirror. Then it shows `ready`. If the import fails, the status is `failed` and `status_detail` says why. Delete the repository and try again.

`wgw repo fork owner/repo` forks in Artifacts. Members of the source fork the full repository, private paths included. Everyone else forks the public projection, so private paths never leave the source. The fork shows `forking` until it is ready. You can only fork a repository that is `ready`.

## 11. Code search

```sh
wgw search "where tokens are checked"                 # the repository of this clone
wgw search "retry with backoff" -R owner/repo --json
wgw search "rate limiter"                             # outside a clone: every public repository
```

Without the CLI:

```sh
curl -s "https://app.wgw.lol/api/repos/OWNER/REPO/search?q=where+tokens+are+checked&limit=10" \
  -H "Authorization: Bearer $WGW_TOKEN"
```

```json
[{ "path": "src/auth.ts", "start_line": 108, "end_line": 145, "snippet": "…", "score": 0.81 }]
```

- Search matches by meaning, not by exact text. Workers AI embeds each file in chunks of about 1,500 characters, and Vectorize stores the vectors.
- The index follows the tip of the default branch. After a push, only the changed files are embedded again.
- Members search every file. Everyone else searches the public paths, the files the public projection shows.
- `GET /api/search?q=` searches the public paths of every public repository. Each result also has `owner` and `name`.
- The index skips binary files, files over 256 KB, lockfiles, and minified files.
- `limit` is 1 to 50. The default is 10.

## 12. API reference

All paths start with `https://app.wgw.lol/api`. Errors are `{"error": "<code>", "message": "<text>"}`.

| Method and path | What it does |
| --- | --- |
| `GET /me` | The token's account and scopes |
| `GET /repos?owner=` · `POST /repos` | List repositories · create one: `name`, `description`, `visibility`, `import_url`, `import_branch` |
| `GET` · `PATCH` · `DELETE /repos/:owner/:repo` | Read, update (`description`, `visibility`, `default_branch`), delete |
| `POST /repos/:owner/:repo/fork` | Fork (`name`); members fork the full repository, others the public projection |
| `POST /repos/:owner/:repo/git-token` | One-hour Artifacts remote and token (`scope`: read, write) |
| `GET /repos/:owner/:repo/refs` | Branches and tags |
| `POST /repos/:owner/:repo/branches` · `DELETE …/branches/:name` | Create (`name`, `from`) or delete a branch |
| `GET /repos/:owner/:repo/tree?ref=&path=` | Directory listing |
| `GET /repos/:owner/:repo/blob?ref=&path=` · `GET …/raw?ref=&path=` | File as JSON (text) · raw bytes |
| `GET /repos/:owner/:repo/commits?ref=&path=&limit=` | History, newest first |
| `GET /repos/:owner/:repo/commits/:sha` · `POST …/commits` | One commit with its diff · commit files |
| `GET /repos/:owner/:repo/compare?base=&head=` | Commits, file diffs, mergeability |
| `GET /repos/:owner/:repo/search?q=&limit=` · `GET /search?q=&limit=` | Code search in one repository · in every public repository |
| `GET` · `POST /repos/:owner/:repo/pulls` | List (`state=open,merged,closed,all`) · open (`title`, `head`, `base`, `body`) |
| `GET` · `PATCH /repos/:owner/:repo/pulls/:n` | Read with diff · update `title`, `body`, `state` |
| `GET /repos/:owner/:repo/pulls/:n/diff` | Unified diff as text |
| `POST /repos/:owner/:repo/pulls/:n/merge` · `…/summary` | Merge · AI summary |
| `GET` · `POST /repos/:owner/:repo/pulls/:n/comments` | Comments |
| `GET` · `PUT` · `DELETE /repos/:owner/:repo/collaborators/:handle` | Collaborators (`role`: read, write, admin) |
| `GET` · `POST /repos/:owner/:repo/environments` · `DELETE …/environments/:name` | Environments and their variable names |
| `PUT` · `DELETE /repos/:owner/:repo/variables/:NAME` | Set (`value`, `secret`, `environment`) or delete |
| `GET /repos/:owner/:repo/env?environment=&format=dotenv` | Opened values for one environment |
| `GET /repos/:owner/:repo/events` | Pushes, merges, secret reads |
| `GET` · `POST /keys` · `DELETE /keys/:id` | API keys (`name`, `scopes`, `repo`, `environment`, `expires_in_days`) |
| `POST /device/code` · `POST /device/token` | CLI device flow |

Repository JSON has `status` (`ready`, `importing`, `forking`, or `failed`), `status_detail` (why it failed, or null), and `storage` (`artifacts`).

Scopes: `read` (private repositories you can see; every key has it), `write` (push, pull requests, commits, write git tokens), `admin` (settings, collaborators, environments, keys), `secrets` (open secret values).

## 13. Limits

- Artifacts stores up to 1 GB per repository and 32 MB per file.
- Artifacts allows 2,000 git requests per 10 seconds per repository.
- A push through app.wgw.lol is one request, and Cloudflare caps a request body at 100 MB. Split larger history into several pushes.
- `GET …/blob` and the web view return no text for binary files or files over 1 MB. Read them with `GET …/raw`.
