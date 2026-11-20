---
name: file-pr
description: >
  File a pull request. Use when the user asks to file, open, or create a PR.
---

# File PR

Use the `full-comms` skill for the title, the body, and the disclosure.

1. Check whether a PR for this branch already exists. If one does, update it, and check the new title and body as step 5 says. Do not open a second PR.
2. Rebase onto the PR's base branch, or the base the user named, usually `origin/master` or `origin/main`. Push as the `babysit-pr` base-branch rule says.
3. Review the diff against that same base, and confirm that it matches the goal. One PR holds one concern. If the change alters behavior, architecture, a term, or a decision, confirm that the docs changed with it, as the `full-docs` skill says.
4. Write the title and body with `full-comms`.
5. Write the body to a file. Read it back, and check the title and body against `full-comms`, rule by rule. Fix what fails.
6. Open a real PR, not a draft, so review bots run. Use the checked body file.
7. Do not turn on auto-merge, and do not merge. Auto-merge is off on all repos. Only the `full-send` skill merges.

If `gh pr create` fails because the GraphQL rate limit is used up, open the PR through REST:

```bash
gh api repos/<owner>/<repo>/pulls -f title=... -f head=... -f base=... -F body=@<file>
```

If the user also asked you to babysit the PR, continue with the `babysit-pr` skill.

Post a follow-up comment only when the user's request needs it.
