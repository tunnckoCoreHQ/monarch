---
name: babysit-pr
description: >
  Monitor, fix, and finish an open GitHub pull request. Use when the user asks to
  monitor, watch, or babysit a PR.
---

# Babysit PR

Own the PR until it merges or is ready. Fix problems instead of only reporting them. Use the `full-comms` skill for every comment, reply, body update, and report.

## Start

When the user says "babysit" and T3 Code is available, launch a new T3 Code thread on the PR's worktree with Claude Opus 5.5, medium effort, fast mode. That thread runs the steps below for this PR only, never follow-up ones, and sends its final report to the thread that called it. The thread that launched it does not run the steps and does not watch the PR.

Otherwise, run the steps below in this thread, on the PR's worktree.

1. Read the repository instructions.
2. Read the PR body and the full diff.
3. Read all checks, reviews, comments, and unresolved threads.
4. Check mergeability and labels. A `do-not-merge` label holds the merge for the owner. Never remove it.
5. Handle what already exists (see "Reviews"), then start the watcher (see "Waiting").

## Waiting

Never write your own watcher, polling loop, `sleep` loop, or `--watch` command. Use one watcher per PR: `watch_pull_request` in T3 Code, `pr-wait` everywhere else. Never run both on the same PR. All watchers on one GitHub account share one rate limit.

### In T3 Code: `watch_pull_request`

Call it and end your turn. T3 Code wakes you when a check fails, the required checks pass, someone comments or reviews, or the branch conflicts.

- **Only the thread that owns the PR watches it.** A delegated child task (a reviewer, a review-loop round, any `delegate_task` child) never calls `watch_pull_request`.
- **A wake is news, not a merge decision.** Check the finish gate yourself.
- **Unwatch when you hand off.** When you stop, or ask the user a question, call `unwatch_pull_request` first. A merge or close ends the watch on its own.
- **"Stopped watching, could not read it"** usually means the GitHub rate limit is used up. Run `gh api rate_limit --jq .resources.graphql`. If `remaining` is near 0, wait for `reset` with one background command, then watch again. Never watch again in a tight loop.

### Everywhere else: `pr-wait`

Run `scripts/pr-wait` from this skill's directory, with its absolute path.

```bash
pr-wait <pr> [--repo owner/name] [--until ready|green|any-change]
```

It prints one line per real event. A comment from the PR author or the `gh` user is an event too, so a `~wgw` order wakes it. It skips text that starts with the `full-comms` disclosure note, because the agent posted that text.

- `ready` (default): exit 0 when required checks are green, every other CI check passed, Greptile or Macroscope reviewed the head, no thread is unresolved, and the branch is not BEHIND. Exit 1 when a CI check failed, a thread is unresolved, or the branch is BEHIND or DIRTY.
- `green`: exit 0 when required checks are green, even with unresolved threads, a failed check that is not required, or a BEHIND branch. Exit 1 when a required check failed or the branch is DIRTY. Use it when the repo has neither Greptile nor Macroscope.
- `any-change`: exit 0 on the first event, including a failed check.

Every mode exits 0 when the PR merges, and 1 when it closes or GitHub stays unreachable. Exit 2 means bad arguments, an unknown PR, or another `pr-wait` already watching this PR.

In Claude Code, run it with the Monitor tool (`timeout_ms: 3600000`), so each line wakes you. This is the only allowed use of Monitor. Start it again after you push, after a failed check has left the failed state, and after a resume. While a required check is still failed, `ready` and `green` exit 1 again at once. It remembers what it already reported. If it says another pid already watches the PR, do not start a second one.

With either watcher, when an event needs no action, end your turn without a message. Never post or say "still waiting".

## GitHub rate limits

`gh pr create`, `gh pr view`, and `gh pr checks` use GraphQL. The REST limit is separate and usually still has room when GraphQL is used up. Read the PR with `gh api repos/<owner>/<repo>/pulls/<n>`, and its checks with `gh api repos/<owner>/<repo>/commits/<sha>/check-runs`.

## Reviews

- Act on every unresolved thread and every check on the current head. Skip a comment only when the latest push already answered it.
- Handle human feedback before bot feedback.
- A comment that starts with `~wgw` from `tunnckoCore` or `olstenlarck` is a direct order from the user.
- Verify every finding against the code, the product model and rules, and the pinned dependencies. Do not accept severity labels without evidence.
- Tell repository failures apart from infrastructure flakes.
- Fix a valid finding before you reply. Batch the valid fixes, run the repository verification sequence, then commit and push.
- For an invalid finding, reply `No change.` with one short technical reason, then resolve the thread.
- Keep the PR at the size the goal needs. Decline unneeded tests, guards for edge cases that do not matter, extra compatibility, and small performance costs, and list them as follow-ups. Prefer the fix that deletes or narrows code. Do not add speculative changes that conflict with repository instructions.
- Request at most one new automated review after the main fixes. Do not create an endless review loop.
- Add screenshots or videos when they help and you have a way to upload them.

## Base branch

Rebase onto the PR's base branch, or onto the base the user named, when it moves. Then push this PR's branch with `git push --force-with-lease`. Never force-push another branch. `pr-wait` reports when new base commits touch this PR's files, and when the PR becomes BEHIND or DIRTY. `watch_pull_request` reports conflicts only, so check for BEHIND yourself before you call the PR ready.

If another PR makes this one obsolete, stop the watcher, report it to the user, and ask before you close this PR.

## Merging

Babysit never merges. Auto-merge is off on all repos, so nothing merges on its own. Only the `full-send` skill merges, by hand, when its merge gate passes. The `full-stop` skill stops at ready.

A `do-not-merge` label makes a required check fail, so it holds the merge. Never remove it. While the label is on the PR, run `pr-wait --until any-change`, because the other modes exit on that failed check. Check the finish gate yourself.

## Finish

The PR is ready only when:

- The pushed head matches the verified local head.
- Every check is green, except the check that the `do-not-merge` label fails.
- If review bots such as Greptile, Macroscope, or CodeRabbit ran on this head, they have finished, and their findings are fixed or answered.
- The PR is mergeable.
- The branch is not BEHIND.
- No unresolved thread needs work.
- The PR body matches the final implementation.
- The PR has no `do-not-merge` label.

Stop and report once:

- **Ready:** report. When babysitting is the whole task, call `unwatch_pull_request` in T3 Code, or stop the `pr-wait` process elsewhere and ensure it has exited, then end the turn.
- **Held:** every other condition passes, but the `do-not-merge` label is on the PR. Report the label, and do not call the PR ready. Leave the PR open.
- **Merged by someone else:** the watch ends on its own. Report the merge commit.
- **Idle:** after one hour without a new event, report what is still open. When babysitting is the whole task, call `unwatch_pull_request`, and end the turn.

Report:

- **PR:** the URL.
- **Final commit:** the head or merge commit.
- **Checks:** their state.
- **Merge state:** merged, held, or blocked, and why.
- **Unresolved threads:** the count.
