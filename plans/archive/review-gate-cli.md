# review-gate: one-command review pipeline (package + CLI)
Origin: chat design session, Oct 2026. Kit v0 (scripts/review-gate) is the starting point.

## Phases
### Phase 1: package skeleton + `review <pr>` end to end
Verified when: `node --test test/run.test.mjs` drives resolve -> gate -> reviewers -> triage -> publish against a fixture repo and a fake GitHub.
Files: bin/review.mjs, src/{cli,config,util,git,github,pr,findings,store,policy,triage,publish,ui}.mjs, src/commands/run.mjs

### Phase 2: reviewer adapters, parallel run, reuse by commit
Verified when: a fake adapter joins the triage queue with no core change; CI results for the same head SHA are reused; local cache prevents re-runs.
Files: src/reviewers/{index,ponytail,llm}.mjs

### Phase 3: CI mode + composite action
Verified when: workflows parse; `review ci policy|reviewers|metrics` run from a GitHub event payload.
Files: src/commands/{ci,metrics}.mjs, action.yml, templates/github/workflows/*

### Phase 4: `review init` + data-pipeline preset + SARIF adapter
Verified when: init on an empty repo writes the files; a SARIF file becomes triageable findings.
Files: src/commands/init.mjs, src/reviewers/sarif.mjs, templates/**

### Phase 5: Claude Code `/pr-review`, non-interactive mode, docs, tests
Verified when: `npm test` green; `npm pack` installs; `review --list/--decide/--submit` work without a TTY.

## Decision log
| # | Decision | Chosen | Why |
|---|---|---|---|
| 1 | Name | package `review-gate`, bins `review` + `review-gate` | free on npm; `review-gate` is the fallback if `review` collides |
| 2 | Where reviewers run locally | reuse CI data for the same head SHA, run the rest locally; `--fresh` forces | cost and speed |
| 3 | Gate locally | display only; CI owns labels and the guide comment | one writer per artifact |
| 4 | Distribution | private GitHub repo, `npm i -g github:<owner>/review-gate` | IP check + dogfood first |
| 5 | Config in target repo | `.review-gate/config.json` | repos carry config, not code |
| 6 | Runtime | Node >= 20, zero runtime deps | small surface to maintain and audit |
| 7 | SARIF | finding schema SARIF-compatible now, adapter in phase 4 | interop with existing scanners |
| 8 | Finding with a file but off-diff | file-level comment when submitting; review body when pending (GitHub limit), with a warning | keeps the body for things with no place in code |

## Always / Never
- Always: every posted comment is a human decision; inline comments are separate threads.
- Never: GitLab/Bitbucket implementation, web triage UI, npm publish (this round).

## Progress
| Phase | Status |
|---|---|
| 1 | done |
| 2 | done |
| 3 | done |
| 4 | done |
| 5 | done |

## Execution record
Shipped: package `review-gate` 0.1.0 (bins `review`, `review-gate`), composite action, `review init`
with presets `default` and `data-pipeline`, reviewers `ponytail`, `llm`, `sarif`, Claude Code
commands `/pr-review` and `/pre-pr`.

Verification:
- `npm test`: 23 tests green (unit, end-to-end `review <pr>`, CI -> local reuse, init, SARIF).
- Load-bearing check: breaking the pending/file-comment rule and the CI-reuse rule each turned a
  test red; restored -> green.
- `actionlint` clean on the workflows written by `review init`.
- `review init --with-ponytail` against the real upstream: SKILL.md identical to commit 96608e0.
- `npm pack` + global install: `review --version`, `review-gate --help` work.

Deviations from plan:
- Phase 2's "fake adapter joins the queue with no core change" is proven with a configured
  `sarif` reviewer (any SARIF command) instead of a test-only adapter type.
- semgrep moved from ci-checks into a `sarif` reviewer in the data-pipeline preset, so its
  findings go through triage like the others.
- Claude Code's built-in `/review` exists, so the command is `/pr-review`.

Not verified live (needs real credentials): Claude Code CLI flags in CI (`--allowedTools`,
`--max-turns`, `--output-format json`), GitHub file-level comments (`subject_type: file`) and
the Linear mutation. First real run should watch these three.
