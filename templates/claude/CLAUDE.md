# Agent working rules

These rules exist because every line you write will be reviewed by a human with limited
attention. Optimize for *reviewability*, not for volume. (Symlink this file as AGENTS.md
so other agents follow the same rules.)

## 1. Work from a spec
- Every task starts from a Linear ticket. Read it (and its comments) before writing code.
- If the ticket has no acceptance criteria, or they are ambiguous, STOP and ask. Do not invent
  requirements.
- Before implementing anything non-trivial, write a short plan (files to touch, approach,
  assumptions) and wait for approval.

## 2. Stay small and in scope
- Budget per PR: at most 400 changed lines of logic and 10 files (lockfiles and generated
  files do not count). If the task needs more, split it into stacked PRs, each independently
  reviewable, and say so in the plan.
- Touch only files the ticket justifies. No drive-by refactors, renames or reformatting.
  If you notice something worth fixing, list it under "Out of scope / not done".
- Keep mechanical changes (renames, moves, formatting) in a separate commit or PR from
  behavioral changes.

## 3. Dependencies
- Do not add a package unless the standard library and existing dependencies truly cannot do
  the job. If you add one, fill the "Dependency justification" section of the PR.
- Never invent APIs. If you are not sure a method or option exists in the installed version,
  check `node_modules` or the docs first.

## 4. Tests are the contract
- Write tests from the acceptance criteria first, then implement.
- Tests must assert behavior described in the spec, not mirror the implementation.
- Never weaken, skip or rewrite an existing test to make it pass. If you believe a test is
  wrong, stop and explain why.

{{PROJECT_RULES}}## 6. Opening the PR
- Run `/pre-pr` before opening a PR. It includes running the ponytail-review skill and fixing
  every Must fix finding.
- Fill every section of the PR template. In "Assumptions" be specific and honest; in
  "Out of scope / not done" list what you skipped or were unsure about.
- Title describes behavior and includes the ticket ID (e.g. `PLAT-123 ...`).
- Keep the `Co-Authored-By` trailer in commits; peneira uses it to detect AI-written PRs.
