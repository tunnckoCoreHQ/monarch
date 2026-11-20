---
name: review-loop
description: >
  Use when the user says "review loop", or "review loop with <model>".
---

# Review loop

Get a review of your change from a second model, the Model, before you file a PR or after. You start the Model as a reviewer, check its findings, fix the valid ones, and start a new round until it approves or the budget runs out.

Fix only valid findings, each with the smallest change. Watch for scope creep, and push back when a finding is wrong.

## Model

The Model is the reviewer for every round of this run.

- Default: the newest Grok Fast model in the T3 catalog, at high reasoning effort, using T3Code Grok Build provider.
- If the user names a model, for example "review loop with Opus 5.5", that model is the Model. Use the effort the user names, else the model's default.
- Call `orchestrator_capabilities` once and pick the Model from it. Do not hardcode an ID.
- If no route runs the Model, report the blocker. Do not substitute another model.
- Record the provider, model, and effort only when the catalog shows them.

## Budget

- Default: 3 rounds total. Round 1 reviews everything. Later rounds check only the changed code and open findings.
- Extend to 5 only for security, permissions, auth, data loss, or state and concurrency, while a `BLOCKER` or `SHOULD` stays open with evidence. Or when the user asks.
- Stop early if a round returns only `NIT` findings. Declined `NIT` findings and comment, doc, or format-only fixes need no new round.
- One reviewer only. The Model must not start subagents or other reviewers.
- Keep a ledger: id, severity, outcome, usage if returned. Never guess usage.

## 1. Scope

Run `git status --short`. Do not stash, discard, or include unrelated changes. Limit the review to the change paths if they separate cleanly. Otherwise stop and ask. Docs, the glossary, and ADRs that the change makes out of date are in scope even outside the change paths.

Find the base after `git fetch origin`:

- PR: `gh pr view <n> --json baseRefName,headRefOid`. Check out the branch only if the working tree is clean. Confirm `HEAD` is the PR head, or ahead only by this change. Base: `git merge-base HEAD origin/<baseRefName>`.
- Local: `git merge-base HEAD origin/<default-branch>`. No remote: a base the user names, or `HEAD` for uncommitted changes only.

The change is base to working tree in those paths, with untracked files. Use one diff command in all rounds. State the intent and what is out of scope in one or two sentences. Run the covering checks. If this change breaks one, fix it before you send the review. Then send it, and list missing checks and checks that already failed before this change in the brief.

## 2. Start the Model

Use `delegate_task` every round (`role: "review"`, `mode: "async"`) with the Model's provider, model, and effort. Save the `taskId`. Use a new `clientRequestId` per round. The `childThreadId` is storage, not the next target. Do not use `t3_thread_send`, `create_threads`, or `t3_thread_launch` for review.

If T3 tools are not listed, try one direct capability call. Outside T3, use a native subagent only if it runs the Model, and keep its ID.

Do not edit scoped files while a review runs. Wait for the notice. Do not poll or start a second reviewer. A timeout, an error, or no reply is not approval. On failure, cancel, confirm that it stopped, and start the next round with the ledger. A failed or silent round counts toward the budget. At the cap, stop as stuck.

Round 1 brief (T3 children get no history):

```text
Review only.
- Do not edit, commit, push, comment on PRs, or start subagents.

Context:
- Repo: <abs path>
- Base: <sha>
- Intent: <intent>
- Out of scope: <scope>
- Checks: <results>

Read:
- git diff <base> [-- <paths>]
- git status --short (read the untracked files too)
- the code around each change

Find:
- bugs
- broken callers
- mismatches with the intent
- docs, glossary, or ADRs that the change made out of date (`SHOULD`)
- code, tests, or guards that the intent does not need
- likely `BLOCKER` or `SHOULD` bugs: swallowed errors, unhandled async rejection or cancellation, unvalidated input, secrets in code, string-built SQL, path traversal, missing auth checks

Ignore:
- style, unless it hides a bug

Severity:
- BLOCKER: the intended case is wrong
- SHOULD: a real bug that callers will hit, inside the intent
- NIT: everything else, including other paths, rare cases, small perf costs, and extra compatibility
- A security, data-loss, or outage bug in the change is never a NIT, even on a rare path

Reply format:
VERDICT: APPROVE | CHANGES
S1 [BLOCKER|SHOULD|NIT] <file>:<line> <claim>. Fix: <suggestion>
(keep the ids stable across rounds)
```

## 3. Answer findings

Check each finding and its severity yourself. A finding about another path, a rare case, or a small cost is a `NIT`, whatever label it came with, unless it is a security, data-loss, or outage bug in the change.

- Agree: make the smallest fix. Prefer deleting or narrowing code over a new lock, cache, helper, or option. Fix the case that happened. Add one focused test that fails without the fix, if the intent needs it.
- Disagree: say why, with evidence (file:line, test, output).
- Out of scope or `NIT`: decline in one line. List it as a follow-up.

Update the ledger. Run the checks and `git diff --shortstat <base>` again. If the review grew the diff, cut first. Do not agree just to end the loop.

## 4. Next round

Start one only if budget remains and a `BLOCKER` or `SHOULD` is open, behavior code changed, or the last approval does not cover the current behavior diff. Use a fresh `delegate_task` in T3, or follow up the saved native ID. Send the round 1 brief, the ledger (`fixed:` / `disagree:` / `declined:` with evidence), the same base diff, and the change since the last round. Tell the Model: open ids and changed code only. Mark each old id `resolved` or `still open: <reason>`.

## 5. Stop and ship

- Agreed: the Model approves the current behavior diff, or returns only `NIT` findings on it. No `BLOCKER` or `SHOULD` is open, and you have no concern of your own.
- Stuck: an item stays disputed after two replies, or the budget ends. Show both sides in two or three lines each. The user decides. The end of the budget is not approval.

Do not push during the loop. Push after agreement only if the user asked to push, ship, or update the PR. A `full-send` or `full-stop` request counts as that ask. If you push to a PR, add this to the PR body. Use the alert that matches the verdict:

```md
> [!TIP]
> Reviewed with review-loop: <N> rounds with <Model>. Verdict: APPROVE.
```

- Only `NIT` findings: `[!NOTE]`, with `Verdict: CHANGES, only NIT findings.`
- Stuck or out of budget, and the user chose to ship: `[!CAUTION]`, with `Verdict: no agreement, <open ids>.`

Add `on <effort>` only if you verified the effort.

Report:

```markdown
- **Rounds:** the count and the Model.
- **Changes:** what the Model made you change.
- **Diff size:** before and after.
- **Findings:** fixed and declined, with reasons.
- **Usage:** as reported, or say that the Model did not report it.
- **Pushed:** yes or no.
```
