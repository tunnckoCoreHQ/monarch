---
name: wgw-git
description: Host, clone, push, review, and merge git repositories on app.wgw.lol, a git platform that runs on Cloudflare. Use it to create repositories, open and merge pull requests, commit files over HTTP without a clone, post CI results on commits, search code by meaning, keep private paths inside a public repository, read deployment secrets for an environment, and get a short-lived token for the Artifacts git remote.
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

1. **A person gives you a key.** They create one at `https://app.wgw.lol/settings`, or run `wgw key create my-agent --scopes read,write --repo owner/repo`. Keys can be limited to one repository and one environment. A limited key cannot create, list, or revoke keys. A key limited to one environment reads repository values as part of that environment but cannot change them. It also cannot change the visibility, collaborators, or environments, or delete the repository.
2. **The CLI device flow.** Run `wgw login`. It prints a URL and a code. A signed-in person (or an agent with an AgentID session) approves it. The CLI stores a 90-day key in `~/.config/wgw/config.json`.
3. **AgentID.** If you own an AgentMail inbox, open `https://app.wgw.lol/auth/agentid/start?login_hint=<inbox>` in your browser. You get an agent account and a browser session; then approve a `wgw login` code with it.
4. **auth.md.** Register yourself with no prior credentials. Follow `https://app.wgw.lol/auth.md`. Before a person claims you, you can read public repositories. After the claim, you act as that person with `read write` scopes for one hour per access token.

Send the token as `Authorization: Bearer <token>`. Git sends it as the HTTP basic password; the username is ignored.

## 2. Install the CLI (optional)

```sh
curl -fsSL https://app.wgw.lol/install.sh | sh
wgw login            # or: wgw login --token "$WGW_TOKEN"
```

The CLI is one file with no dependencies. It needs Node 20+ or Bun. `WGW_TOKEN` overrides the stored key.

A command picks its repository in this order: the `owner/repo` argument of `repo view`, `repo token`, `repo fork`, and `repo delete`, then `-R owner/repo`, then the git remote of the clone you run it in. `wgw repo delete` never reads the git remote, so name the repository. Flags take `--flag value` or `--flag=value`, and a value may start with a dash, as in `--body "- item"`. A missing argument prints a usage line and exits 1.

```sh
wgw help                             # every command and flag
wgw whoami                           # the account behind the key
wgw logout                           # forget the stored key
wgw version
wgw repo list [owner]
wgw repo view owner/repo             # status, branches, clone URL
wgw repo delete owner/repo --yes
wgw ls [path] [--ref main]           # list a directory
wgw cat README.md [--ref main]       # print a file
wgw log [--ref main] [--limit 20]    # newest first, up to 200
wgw env list
wgw env delete preview               # deletes its values too
wgw secret delete NAME [--env production]
wgw key list                         # each key's scopes, repository, environment, and expiry
wgw key revoke tok_…
wgw collab list
wgw collab add alice --role write    # read, write, or admin
wgw collab remove alice
wgw api GET /api/me                  # any API call; prints the response
```

## 3. MCP

The remote MCP server at `https://app.wgw.lol/mcp` uses Streamable HTTP and keeps no session. Claude Code, Cursor, and other MCP clients get the API as tools.

```sh
claude mcp add --transport http wgw https://app.wgw.lol/mcp --header "Authorization: Bearer $WGW_TOKEN"
```

Other clients take the same URL and header. The token is a wgw API key or an auth.md access token. Each tool calls the API with it, so the key's scopes, its repository limit, and `.gitprivate` apply as they do over the API. Without a token you get only the read tools, and they see public repositories and public paths. An invalid or expired token gets 401 with a `WWW-Authenticate` header that points at `/.well-known/oauth-protected-resource`.

- For everyone: `whoami`, `list_repos`, `get_repo`, `list_tree`, `read_file`, `search_code`, `list_commits`, `get_commit`, `compare`, `list_pulls`, `get_pull` (with the unified diff), `list_statuses`, and `get_git_token`.
- With a token: `create_repo`, `create_branch`, `commit_files`, `open_pull`, `comment_pull`, `merge_pull`, `set_status`, and `pull_env`. The `pull_env` tool opens secrets, so it needs write access and a key with the `secrets` scope.

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
  "remote": "https://<account>.artifacts.cloudflare.net/git/app-wgw-lol/repo_<id>.git",
  "token": "art_v…",
  "scope": "read",
  "expires_at": "2026-10-11T13:00:00.000Z",
  "view": "full"
}
```

- The Artifacts remote names the repository by its id, not by its name. The public projection is `repo_<id>.public.git`.
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
    "from": "<where a new branch starts, or omit>",
    "files": [
      { "path": "README.md", "content": "# Title\n" },
      { "path": "logo.png", "content": "<base64>", "encoding": "base64" },
      { "path": "old.txt", "delete": true }
    ]
  }'
```

Without `branch`, the commit goes to the default branch. A branch that does not exist is created from the tip of the default branch, or from `from` (a branch, tag, or commit hash). The commit keeps that tree and changes only the files you send, so a pull request from the branch merges. `from` on a branch that already exists is a 409.

Each file takes an optional `mode`: `100644` (a regular file), `100755` (an executable), or `120000` (a symlink, with the link target as its content). Without one, an updated file keeps its mode and a new file is `100644`.

With `expected_sha`, the commit fails with 409 when someone else moved the branch first. Use it when several agents work on one branch.

```sh
wgw commit --branch agent/fix -m "docs: fix" README.md=./README.md --delete old.txt
wgw commit --branch agent/fix -m "docs: more" --expected-sha <tip> README.md=./README.md
wgw commit --branch hotfix -m "fix: retry" --from v1.2.0 src/retry.ts=./src/retry.ts
```

## 7. Pull requests

```sh
wgw pr create --head agent/fix-typo --title "Fix a typo" --body "One word."
wgw pr list            # --state open (default), merged, closed, or all
wgw pr view 3          # title, body, commit and file counts, mergeable or not
wgw pr diff 3          # unified diff, ready for review
wgw pr summary 3       # Workers AI summary of the diff
wgw pr comment 3 --body "Looks right."
wgw pr merge 3         # fast-forward when possible, else a merge commit
wgw pr close 3         # wgw pr reopen 3 opens it again
```

Merges run on the server. The mirror makes the merge commit and pushes it to Artifacts. A path changed differently on both sides is a conflict; the merge fails with 409 and names the paths. Rebase locally and push again.

## 8. Commit statuses

A status is a pass or fail result on one commit, such as a CI run or an agent's review. Each commit keeps one status per `context`, like `tests` or `lint`. Posting a context again replaces it, so post `pending` when a run starts and `success` or `failure` when it ends.

```sh
# in CI, after the tests pass
wgw status set $(git rev-parse HEAD) success --context tests
wgw status set $(git rev-parse HEAD) failure --context tests --description "3 failed" --url https://ci.example/run/41
wgw status list $(git rev-parse HEAD)          # each context and the combined state
```

Without the CLI:

```sh
curl -s https://app.wgw.lol/api/repos/OWNER/REPO/statuses/$(git rev-parse HEAD) \
  -H "Authorization: Bearer $WGW_TOKEN" -H 'content-type: application/json' \
  -d '{ "state": "success", "context": "tests", "description": "212 passed", "target_url": "https://ci.example/run/41" }'
```

- `state` is `pending`, `success`, `failure`, or `error`. `context` is 1 to 100 characters and defaults to `default`. `description` is up to 140 characters. `target_url` must be `https://`.
- The hash is a full 40-character commit hash the repository has. Push the commit first; an unknown hash is a 404.
- Posting needs write access and a key with the `write` scope. A key limited to one repository posts only there. A key limited to one environment can post.
- `GET …/statuses/:sha` returns `{ "sha", "state", "statuses" }`. The combined `state` is `failure` when any status failed or errored, else `pending` when any is pending, else `success`. It is null when the commit has no statuses.
- A pull request shows the statuses of its head commit in the merge panel, and `GET …/pulls/:n` returns them as `status`. The pull request list and the commit list carry the combined state as `status`.
- Statuses do not block a merge.
- Everyone else asks with the public view's hashes, the ones they see in the history. A commit that touched only private paths has no public hash, so its statuses stay with the members.

## 9. Private paths in a public repository

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
- The repository activity and pull requests show everyone else the public hashes. The activity leaves out secret reads and pushes that touched only private paths.

Check what the public sees: `curl -s https://app.wgw.lol/api/repos/OWNER/REPO/tree` without a token.

## 10. Environments and secrets

```sh
wgw env create production --kind production     # kinds: production, staging, preview, development
wgw secret set DATABASE_URL --env production     # reads the value from stdin
wgw secret set LOG_LEVEL --plain info            # repository-wide, not secret
wgw env pull production > .env                   # needs a key with the secrets scope
```

Running `env create` on an environment that exists changes its kind only when you pass `--kind`. An unknown kind is a 400, and `env pull` of an unknown environment is a 404.

Repository values apply to every environment and environment values override them. Secret values are sealed with AES-256-GCM under a key that belongs to the repository. That key is stored in D1 wrapped by a master key in Cloudflare Secrets Store, and it is deleted with the repository. Only `GET /api/repos/OWNER/REPO/env?environment=NAME` opens them, it needs write access plus the `secrets` scope, and every read is logged in the repository activity.

## 11. Imports and forks

```sh
wgw repo create lib --import https://github.com/owner/lib                    # the default branch
wgw repo create lib-dev --import https://github.com/owner/lib --import-branch dev
wgw repo view you/lib                                                        # status: importing, then ready
```

An import copies one branch: the remote's default branch, or `import_branch` when you give one. Push other branches yourself after the import. Artifacts runs the import. The repository shows `"status": "importing"` until a Workflow sees the import finish and syncs the mirror. Then it shows `ready`. If the import fails, the status is `failed` and `status_detail` says why. Delete the repository and try again.

`wgw repo fork owner/repo` forks in Artifacts. Members of the source fork the full repository, private paths included. Everyone else forks the public projection, so private paths never leave the source. The fork shows `forking` until it is ready. You can only fork a repository that is `ready`. The fork keeps the source's name; to fork your own repository, pass `--name <new>`.

## 12. Code search

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
- The index follows the tip of the default branch. After a push, only the changed files are embedded again. New pushes show up in search within about two minutes. Until then, a query can return the old results, a deleted file, or nothing.
- Members search every file. Everyone else searches the public paths, the files the public projection shows.
- `GET /api/search?q=` searches the public paths of every public repository. Each result also has `owner` and `name`.
- The index skips binary files, files over 256 KB, lockfiles, and minified files.
- `limit` (`--limit` in the CLI) is 1 to 50. The default is 10. Any other value is a 400.

## 13. API reference

All paths start with `https://app.wgw.lol/api`. Errors are `{"error": "<code>", "message": "<text>"}`. A JSON field of the wrong type is a 400 that names the field.

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
| `GET /repos/:owner/:repo/commits?ref=&path=&limit=` | History, newest first; `limit` is 1 to 200, 30 by default |
| `GET /repos/:owner/:repo/commits/:sha` · `POST …/commits` | One commit with its diff · commit files (`branch`, `message`, `files`, `expected_sha`, `from`) |
| `GET` · `POST /repos/:owner/:repo/statuses/:sha` | Statuses of a commit with the combined state · post one (`state`, `context`, `description`, `target_url`) |
| `GET /repos/:owner/:repo/compare?base=&head=` | Commits, file diffs, mergeability |
| `GET /repos/:owner/:repo/search?q=&limit=` · `GET /search?q=&limit=` | Code search in one repository · in every public repository |
| `GET` · `POST /repos/:owner/:repo/pulls` | List (`state=open,merged,closed,all`) · open (`title`, `head`, `base`, `body`) |
| `GET` · `PATCH /repos/:owner/:repo/pulls/:n` | Read with diff and head commit statuses · update `title`, `body`, `state` |
| `GET /repos/:owner/:repo/pulls/:n/diff` | Unified diff as text |
| `POST /repos/:owner/:repo/pulls/:n/merge` · `…/summary` | Merge · AI summary |
| `GET` · `POST /repos/:owner/:repo/pulls/:n/comments` | Comments |
| `GET` · `PUT` · `DELETE /repos/:owner/:repo/collaborators/:handle` | Collaborators (`role`: read, write, admin) |
| `GET` · `POST /repos/:owner/:repo/environments` · `DELETE …/environments/:name` | Environments and their variable names; create (`name`, `kind`) |
| `PUT` · `DELETE /repos/:owner/:repo/variables/:NAME` | Set (`value`, `secret`, `environment`) or delete |
| `GET /repos/:owner/:repo/env?environment=&format=dotenv` | Opened values for one environment; 404 for an unknown one |
| `GET /repos/:owner/:repo/events` | Pushes, merges, secret reads |
| `GET` · `POST /keys` · `DELETE /keys/:id` | API keys (`name`, `scopes`, `repo`, `environment`, `expires_in_days`); revoking an unknown key is a 404 |
| `POST /device/code` · `POST /device/token` | CLI device flow |
| `GET /agents` · `DELETE /agents/:id` | auth.md agents you claimed · revoke one and its tokens |

Repository JSON has `status` (`ready`, `importing`, `forking`, or `failed`), `status_detail` (why it failed, or null), and `storage` (`artifacts`).

Scopes: `read` (private repositories you can see; every key has it), `write` (push, pull requests, commits, commit statuses, write git tokens), `admin` (settings, collaborators, environments, keys), `secrets` (open secret values).

## 14. Limits

- Artifacts stores up to 1 GB per repository and 32 MB per file.
- Artifacts allows 2,000 git requests per 10 seconds per repository.
- A push through app.wgw.lol is one request, and Cloudflare caps a request body at 100 MB. Split larger history into several pushes.
- `GET …/blob` and the web view return no text for binary files or files over 1 MB. Read them with `GET …/raw`.
