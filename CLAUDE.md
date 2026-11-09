# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`peneira` is a Node 20+ CLI (plain ESM `.mjs`, **zero runtime dependencies**, no build step) that runs AI/static reviewers on a GitHub PR, lets a human triage each finding, and posts only the chosen ones as one GitHub review. `README.md` is the user-facing spec. Keep it in sync when behavior, flags, config keys or env vars change.

## Commands

```bash
npm test                                    # node --test test/*.test.mjs (no network)
node --test test/unit.test.mjs              # one file
node --test --test-name-pattern "dedupe" test/run.test.mjs   # one test by name
node bin/peneira.mjs 14 --dry-run           # run locally against PR #14 without writing to GitHub
PENEIRA_DEBUG=1 node bin/peneira.mjs ...    # print stack traces on errors
npm run typecheck                           # tsc --checkJs, no emit (devDependency only; runtime stays zero-dep)
```

Type errors in JS are fixed with defaults or JSDoc (`@param {{...}}`), not `// @ts-ignore`. `strict` is off.

## Architecture

Entry: `bin/peneira.mjs` → `src/cli.mjs` `main(argv, { io, env, cwd, fetchImpl })`. Every command takes `io`, `env`, `cwd` and `fetchImpl` as injected params instead of reading globals. That injection is how tests run the CLI end to end: keep it intact when adding code.

Default command (`src/commands/run.mjs`) pipeline:
1. `pr.mjs` resolves the PR (number, URL, or current branch); `git.mjs` wraps git.
2. `policy.mjs` computes the gate (logic-line budget, ticket, PR template sections, risk paths/patterns). Locally it is display only. `peneira ci policy` applies labels and the guide comment.
3. `reviewers/index.mjs` plans and runs reviewers in parallel. Results are reused in this order: CI results stored on the PR for the same head SHA, then the local cache at `.git/peneira/<pr>/<headSha>/<name>.json`, then a fresh run.
4. `triage.mjs` does interactive triage, or applies `--decide "P1=c,A1=f:reason"` non-interactively. Decisions are saved to `.git/peneira/<pr>/triage.json`.
5. `publish.mjs` turns the decisions into one review. Lines inside the diff become inline threads (`diffindex.mjs` maps them). Other in-PR lines become file comments, or go in the review body while the review is pending. `github.mjs` is the **only** module that calls the GitHub API (token from `GITHUB_TOKEN`/`GH_TOKEN`/`gh`).

Key contracts:
- **Finding** (`findings.mjs` `makeFinding`): `{id, source, group: must|should|nice, title, file, line, endLine, parts, fingerprint}`. Fields follow SARIF. The fingerprint is `source|file|normalized title`, and it is how earlier triage decisions are matched across runs.
- **Reviewer adapter** (`reviewers/*.mjs`): exports `available(ctx) → {ok, reason}` and `run(ctx) → {title, intro?, findings, meta?}`. Register it in `TYPES` in `reviewers/index.mjs`. `runReviewer` never throws; failures come back as `{error}`/`{skipped}`.
  - `ponytail`: runs the ponytail-review skill headless through the `claude`/`cursor`/`codex` CLI (`PENEIRA_RUNNER`), read-only.
  - `llm`: on the agent transport, the first skill found from `reviewers.llm.skills` (`skills.mjs` searches `.agents/.claude/.cursor/skills` in the repo, then in `$HOME`, then the bundled `templates/skills/`; the default is `high-signal-review`). The skill owns the review method and peneira's prompt owns only the contract (headless, read-only, JSON shape). On the HTTP API, or when no skill is found, it uses the built-in prompt.
  - Claude runs pass `READ_ONLY` (`--setting-sources project --permission-mode default`), because user hooks can approve any Bash command, subagents included. Keep it on every `claude` invocation.
  - `sarif`: any SARIF-emitting command.
- **PR state store** (`store.mjs`): CI persists reviewer results in sticky issue comments with `<!-- peneira:reviewer:NAME -->` markers and a base64 `<!-- peneira:data ... -->` block. Only this module knows the marker formats.
- **Config** (`config.mjs`): `DEFAULTS` → `~/.peneira/config.json` → `.peneira/config.json`. Objects deep-merge and arrays replace. Scope values `all|ai|ai-or-risk|none` go through `appliesTo`.

`templates/` holds what `peneira init` writes into *target* repos (AGENTS.md, slash commands, workflows, presets). It is not config for this repo. `templates/skills/` is the exception: skills peneira bundles and reads in place. `action.yml` is the composite GitHub Action those workflows call.

## Tests

`test/helpers.mjs` provides the fixtures:
- `fixtureRepo()`: a temp git repo with an "AI-written" feature branch.
- `fakeGitHub()`: an in-memory REST API passed as `fetchImpl`. Add routes here when `github.mjs` starts calling new endpoints.
- `fakeClaude()`: a fake runner binary.
- `scriptedIO`: scripted keypresses for interactive triage.

Tests call `main()`/`runReview()` directly with these fakes.
