---
description: Self-check before opening a PR (budget, scope, tests, ponytail-review, PR description)
---

Run this checklist before opening a pull request. Report results as a short table, then
produce the PR description.

1. Identify the ticket ID from the branch name or ask me. Re-read the ticket and list its
   acceptance criteria.
2. Run `git diff --stat origin/main...HEAD`. If the change is over the budget in
   `.peneira/config.json` (default 400 logic lines / 10 files), STOP and propose how to
   split it into stacked PRs.
3. For every changed file, state which acceptance criterion justifies it. Flag any file that
   no criterion justifies.
4. Run `npm run lint`, `npm run typecheck` and `npm test` (whichever exist). Fix failures
   without weakening tests.
5. Map each acceptance criterion to the test(s) that prove it. Flag criteria without a test.
6. Check `package.json` diffs for new dependencies; if any, justify each one.
7. Walk through the project invariants in AGENTS.md section 5 and note which apply.
8. Run the ponytail-review skill on `origin/main...HEAD`. Fix every "Must fix" finding. For
   "Should fix" findings, fix them or explain in the PR description why not. Re-run until no
   Must fix findings remain.
9. Write the PR description following `.github/pull_request_template.md` exactly, with honest
   Assumptions and Out of scope / not done sections. Save it to `.pr-description.md`.
