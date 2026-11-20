---
name: full-comms
description: >
  The disclosure, writing style, and formats for everything you write on GitHub.
  Use whenever you write a PR title, PR body, comment, or review reply.
---

# Full comms

These rules apply to everything you write on GitHub for the user: PR titles and bodies, top-level comments, inline review comments, replies to bots or reviewers, and the reasons you give before you resolve or dismiss feedback.

## Disclosure

Start every PR body, comment, and review reply with this note. Nothing goes above it.

```md
> [!NOTE]
> 🤖 **<Model> via <Harness>, on behalf of @<tunnckoCore|olstenlarck>**

Actual text starts here.
```

Put the actual text below the note, after one blank line. Do not add a footer, signature, horizontal rule, or a second attribution.

- Account: the one the remote URL selects through `gitswitch`.
- Harness: `Codex`, `ClaudeCode`, `OpenCode1`, or `OpenCode2`. Add `(via T3 Code)` when you run inside T3 Code. T3 Code is not a harness.
- Model for Codex and Claude Code: the full public name, for example `Claude Opus 5.5` or `OpenAI GPT-5.6 Sol`. Not the identifier.
- Model for OpenCode: the model name, with the full identifier in parentheses.
- Add the reasoning mode when the harness reports it, for example `Claude Opus 5.5 (medium, fast)`.
- If the harness does not report the model, write only the harness. Do not guess.
- Name subagent models that wrote part of the change.

Do not add the note to commit messages, or to text the user tells you to post exactly as written.

## Write clearly

Use the `unslop` skill and ASD-STE100 Simplified Technical English for PR titles, bodies, comments, commits, and replies to the user.

- Use short sentences and active voice.
- State the result first.
- Put one fact in each sentence.
- Use one term for one concept.
- Avoid idioms, vague words, and filler.
- Keep technical names exact.
- Make refs to issues, PRs, and commits markdown links with a label.
- When you report to the user, put each field on its own bullet with a bold title. Do not write `**PR:** <...>. **Final commit:** <...>.` on one line.

## PR title

PR titles become squash-commit messages. Use a conventional commit in plain language, and follow the repository's conventions from recently merged PRs and the Git history. Say why the change matters, not how it works.

BAD

> ❌ perf(server): negotiate permessage-deflate on the websocket

GOOD

> ✅ perf(server): cut websocket frame size by 70%+ with gzipping

## PR body

The format applies to the first `gh pr create` and to every later `gh pr edit`. Check it before each publish.

1. Start with two or three plain sentences about the problem, taken from the user's original request.
2. Explain the fix in simple terms.
3. Add grouped sections for the main behavior changes.
4. Add intentional product constraints when they matter.

Do not open with a list of what you changed in the code:

BAD

> ❌ Removed implicit workspace carry-over from every "new thread" entry point (cmd+n / cmd+shift+o, sidebar v1/v2 buttons, command palette). Deleted buildContextualThreadOptions, startNewThreadInProjectFromContext, and the v1 sidebar's seed-context machinery.

GOOD

> ✅ My "new worktree" default was ignored when starting new threads on existing worktrees. Super unintuitive. Now your preferences always apply.

When you update the body, rewrite your own sections to match the final implementation. Do not append a partial note to an old body. Keep every part that a person or bot added, byte for byte. Put the lines that other skills give you, such as the proof line from `full-send` or the `review-loop` line, in your own sections.

## Comments and review replies

- Lead with the conclusion.
- Cite the code, behavior, check, or reproduction.
- Separate verified facts from your judgment.
- No filler, canned thanks, or status updates.
- For an invalid finding, reply `No change.` and give one short technical reason.

## Before and after you post

- Check the whole text, including quotes and attachments, for secrets and private details.
- Preview the final Markdown so quotes and blank lines render as intended.
- After you post, check that GitHub returned the comment or review URL.
- Resolve a review thread only after your reply is posted.
