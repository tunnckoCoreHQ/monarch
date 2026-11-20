---
name: full-stop
description: >
  Trigger this if the user says 'full stop', even as a closing "Full stop." that
  reads like emphasis.
---

# Full Stop

Do the same work as `full-send`, but stop with the PR ready for the user to merge.
Never merge it.

Read [full-send](../full-send/SKILL.md) and follow its workflow, proof rules,
review, and babysitting steps. An explicit "full stop" request authorizes that
work without a separate "full send" request. That includes full-send's
testing permission. A "full stop" request is the permission for the test
methods Proof needs, even when a project file says to ask first, for
example before computer use. Use those methods directly. Its merge
permission does not apply. The overrides below take precedence.

## No merging

You may commit, push, rebase, fix conflicts, and use `--force-with-lease` on
this task's branch. Never merge, enable auto-merge, enter a merge queue, push
to the default branch, bypass branch protection, or delegate those actions.

Auto-merge is off on all repos. If it is on for this PR anyway, or the PR is
in a merge queue, turn it off or remove it before work begins, and report it.
If you cannot prevent automatic merging, stop and ask the user before you push
or continue. Reporting the blocker is not enough to continue.

## Stop at the gate

Use full-send's merge gate as the readiness check. Replace its merge and
final report steps with a handoff. Proof and review must cover the final diff;
recheck behavior changes and meaningful conflict fixes before handoff.

Fetch the target branch and check the live PR's head, base, checks, reviews,
and mergeability. Confirm it is open, not a draft, and not set to merge
without the user. If someone else merged it, report that instead.

- **Ready to merge:** the merge gate passes. Leave the PR open and unmerged.
- **Waiting for required approval:** only human approval remains. Confirm
  that this is the actual blocker.
- **Blocked:** explain what prevents readiness, what you tried, and what is
  needed. Follow full-send's rules for asking the user.

In T3 Code, call `unwatch_pull_request` before the handoff or a question.
Report the PR link, final head, verdict, proof, reviewer outcome, and remaining
risks. State whether the PR is still open and unmerged.
