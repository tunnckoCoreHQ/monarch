---
name: full-send
description: >
  Trigger this if the user says 'full send'.
---

# Full Send

If the user triggered this, it's because they are not watching this thread, and
they want you to complete the work end-to-end autonomously. Your updates and
your final message go unread until long after you stop. You own the work from
its current state to a merged PR.

If the user did not explicitly request "full send" in some clear way, do not
assume full autonomy. If they did, everything below applies.

The user grants you permission to:

- Merge the PR once the merge gate passes.
- Force-push the PR's own branch with `--force-with-lease` after a rebase.
- Use the test methods that Proof needs, without asking first.

## Testing permission

A "full send" request is the permission. If a project file or other
instruction says to ask before a test method, or to leave testing to the
user, this request replaces that rule for this task.

That includes ask-first rules for computer use, browser automation,
simulators and devices, running the app or a dev server, screenshots, and
visual checks. Use the method that gives direct proof. List it in the
report.

Rules about how to test still apply. Follow rules that name the correct
command, fixture, or check. This permission only removes the ask-first or
leave-it-to-the-user step. If a preferred method cannot prove the change,
use a gated method under this permission.

It covers only the tests needed for this task. It does not add permission
for the steps under "Asking the user", such as production changes or data
deletion. It also does not bypass a harness or system approval prompt if
one appears.

## Steps

1. **Finish the change.** Complete the goal from the user's request with the
   smallest change that works. Fix the case that happened, not every case
   that could. If you are on the default branch, create a branch first.
   Update the docs with the `full-docs` skill. If the user's request also
   names `hill-climb` ("full send hill climb"), reach the goal with that skill.
   Then continue from "Prove it". The climb report is part of the proof.
2. **Prove it.** Get proof for every change you made. See "Proof".
3. **Get feedback.** Run the `code-review` skill once and fix its findings.
   Then run the `review-loop` skill.
4. **File the PR** with the `file-pr` skill. Add the proof to the PR body in
   this format. Say what the proof shows, not which commands ran.

   ```md
   ## Proof

   - Tests, typecheck, and lint pass.
   - The CLI output matches the old build on 12 sample inputs.
   ```

5. **Babysit the PR** with the `babysit-pr` skill. Fix real findings and CI
   failures. Get proof for each fix before you push it. When babysit reports
   ready, held, or idle, do not end the turn. Continue with the next step.
6. **Merge** when the merge gate passes.
7. **Report** in your final message: the PR link, the merge commit, your proof,
   and each decision you made for the user.

Stay active from step 1 to step 7. If you end your turn while checks or bots are
pending, the work stops, because nobody will prompt you again. Wait with the
watcher from `babysit-pr`, so something wakes you when the PR changes. In T3
Code that is `watch_pull_request`. If you stop before the merge, call
`unwatch_pull_request` first.

## Proof

Proof is evidence you observed yourself in this session: command output, a
reproduction, a screenshot. Use the most direct proof the change allows:

- Reproduce the original failure, apply the fix, then watch the same
  reproduction pass.
- Run the checks that the repo's CI runs (typecheck, lint, tests).
- Add one focused test that fails without the fix, when the behavior has none
  and the repo has a test setup.
- For UI and runtime behavior, run the app and look at the change. Green mocked
  tests do not prove that the user experience works. Attach screenshots to the
  PR when they help and you have a way to upload them.

When you cannot find a way to prove a change, you do not have full confidence.
Ask the user.

## Merge gate

Full confidence means all of these are true on the latest commit:

- Your proof covers every change in the diff.
- The `babysit-pr` finish gate passes.
- Each review finding is fixed, or dismissed with a written reason. A bot note
  that only asks for human review gets `No change.` and one short reason, as
  `full-comms` says. That note alone does not block the merge.
- No human review still requests changes.
- The PR has no `do-not-merge` label. Never remove it. If it is present, ask the user.
- The branch is up to date with the PR's base branch, usually `origin/master` or `origin/main`, and GitHub reports it as mergeable.

Auto-merge is off on all repos, and the `babysit-pr` and `full-stop` skills
never merge. Full-send is the only flow that merges, and it merges by hand.

Right before the merge, run `git fetch` and check the PR again. Never merge
when it is BEHIND or DIRTY, or when base commits that landed after the last
green run touch this PR's files. Rebase, push, and wait for green again.

If the base branch uses a merge queue, ask the user before you run
`gh pr merge`. On such a base, that command adds the PR to the queue, which
uses its own merge method and does not hold the PR when a review requests
changes later.

Squash-merge with `gh pr merge --squash --match-head-commit <sha>`, where
`<sha>` is the head that passed the merge gate. If the head moved, check the
gate again. Never create merge commits. Stay until GitHub reports the PR as
merged. Merge through branch protection as configured. Never use `--admin` or
other bypasses. You can ignore automated reviews that request "needs human
review" if you have high confidence in your changes.

## Asking the user

A question in a normal message goes unseen, and the thread looks done. To ask
the user something, use the harness's question tool so the thread shows that
it is waiting: `AskUserQuestion` in Claude Code, `request_user_input` in Codex,
or the question tool your harness has. Put all the context in the question:
the PR link, what blocks you, and the options with your recommendation first.

Ask only when you cannot continue alone:

- You cannot prove the change.
- The merge gate cannot pass, and you cannot fix that yourself.
- The next step is outside the grant above: deleting data, touching production,
  changing things outside the repo, closing a PR, or force-pushing any other
  branch.
- The goal is ambiguous in a way that changes the result.
- Another PR makes this one obsolete.

Decide everything else yourself with sensible defaults, and list those decisions
in the report.

If no question tool is available, or the tool returns no answer, take the safe
path: leave the PR open and unmerged, and start your final message with the
question.
