# peneira

> **peneira** (pe-NAY-ra) · *Portuguese for sieve.*
> On Brazilian coffee farms, machines harvest and dry the beans; people sift them by hand.
> **AI finds the issues. You decide what ships.**

```bash
peneira 14
```

AI reviewers are good at finding problems and bad at knowing which ones matter. peneira
runs the reviewers, holds their findings, and lets you decide finding by finding what the
author sees. Every posted comment is a human decision.

```
✔ PR #14 "PLAT-482 Dedupe events on retry"  @claude-bot · head c6e7654
● Gate: warnings · 212 logic lines / 6 files · AI-generated · risk: high
✔ ponytail: 3 finding(s) [CI]
✔ llm (code-review): 4 finding(s) [local]
✔ semgrep: 1 finding(s) [local]

Triage: 8 finding(s) (1 must, 5 should, 2 nice)
[1/8] MUST FIX  ponytail P1  src/ingestion/worker.js:2-3  → inline
Retries insert duplicates
  Problem: A retry re-inserts the whole batch.
  Fix: Insert with dedupe_key.
▶    2   const retries = 3;
▶    3   for (const e of batch) await insert(e);

[c]omment  [e]dit+comment  [g]eneral note  [i]gnore  [f]alse positive  [t]icket  [b]ack  [q]uit
```

## Install

```bash
npm i -g github:leofmds/peneira     # or: git clone https://github.com/leofmds/peneira && npm link
peneira --version
```

Installs two commands: `peneira` and its short alias `review`.

Requires Node 20+, git, and a GitHub token (`GITHUB_TOKEN`, or just `gh auth login`).
No runtime dependencies.

## Quick start

```bash
cd your-repo
peneira init --preset data-pipeline --with-ponytail
peneira 14            # or just `peneira` on the PR's branch
```

## What `peneira <pr>` does

1. **Resolves the PR**: `14`, `#14`, a PR URL, or nothing (the open PR of the current branch).

   Note: in bash, `peneira #14` treats `#14` as a comment and runs `peneira` with no argument,
    which still works if you are on the PR's branch. Use `peneira 14` to be explicit.
2. **Gate** (display only; CI owns labels and the guide comment): size budget counting only

   logic lines, linked ticket, required PR description sections, new dependencies, risk paths
    and risky patterns in added lines. `--guide` prints the full reading order.
3. **Reviewers** run in parallel. Results already produced by CI for the same head commit are

   reused; local results are cached per commit in `.git/peneira/`. `--fresh` forces a re-run.
4. **Triage**, Must fix first, all reviewers in one queue. Findings you triaged before are not

   asked again (`--all` to see them).
5. **Publish** one GitHub review, pending by default.
6. **Remember** your decisions in `.git/peneira/<pr>/triage.json` on this machine, so the next run skips findings you already triaged.

### Where each comment goes

Every finding you choose to comment on becomes its own thread on its own code. The review body
only gets what has no place in the code.

| Finding | Pending review | Submitted (comment / request changes) |
|---|---|---|
| Line inside a diff hunk | inline thread on that line (or line range) | inline thread |
| File in the PR, line outside the diff | review body (GitHub cannot hold file comments in a pending review; the CLI warns) | file-level comment on that file |
| No location, or you chose `[g]` | review body | review body |

### Triage keys

| Key | Action |
|---|---|
| `c` | Comment as written |
| `e` | Rewrite in `$EDITOR`, then comment |
| `g` | General note in the review body |
| `i` | Ignore (recorded, not posted) |
| `f` | False positive, optional reason (feeds the metrics) |
| `t` | Linear follow-up ticket, optionally with a comment linking it (`LINEAR_API_KEY` + `triage.linearTeamKey`) |
| `b` / `q` | Back / finish and choose how to post |

### Options

```
--fresh            ignore CI results and the cache; run every reviewer locally
--only a,b         only these reviewers
--all              include findings triaged before
--guide            print the full Review guide
--list [--json]    print findings and exit
--decide SPEC      non-interactive triage: "P1=c,P2=i,A1=f:unreachable,A3=g"
--submit MODE      pending (default) | comment | request-changes | none
--dry-run          print what would be posted, write nothing
--repo owner/name  override the repo inferred from origin
```

## In Claude Code

`peneira init` writes `AGENTS.md` (the shared rules) and the checklists in `.agents/workflows`.
`CLAUDE.md` is a one-line `@AGENTS.md` import. Two slash commands point at those checklists:

- `/pr-review 14`: Claude runs `peneira 14 --list --json`, walks you through each finding one at a
time, asks for your decision, and posts with `--decide`. It never decides for you.
- `/pre-pr`: the author-side checklist, including running ponytail-review and fixing every
Must fix before opening the PR.

## Reviewers

Configured in `.peneira/config.json` under `reviewers`. Each has `enabled`, `prefix` (finding
ids), and `runFor`: `all` (the default, unless `.peneira/config.json` sets it), `ai` (AI-generated PRs), `ai-or-risk`.

| Type | What it is | Needs |
|---|---|---|
| `ponytail` | The [ponytail-review](https://github.com/DietrichGebert/ponytail) skill (MIT), run headless through Claude Code, the Cursor agent CLI, or Codex. Reads callers, tests and expected load, not only the diff. Read-only: Claude's tool allowlist, Cursor ask mode, or Codex `--sandbox read-only`. | `reviewers.ponytail.runner`: `claude` (default), `cursor`, or `codex`, overridden by `PENEIRA_RUNNER`. That CLI, and the skill at `.agents/skills/ponytail-review/SKILL.md` (`init --with-ponytail`; `.claude/skills/...` and the Claude plugin still count) |
| `llm` | The first installed skill in `reviewers.llm.skills` (see [Review skill](#review-skill)). It reviews read-only and does not post. With none installed, a built-in prompt judges the diff against the ticket (fetched from Linear when `LINEAR_API_KEY` is set) and the CLI prints how to install the missing skills. `provider`: `anthropic` or `openai`; `focus` adds project-specific guidance. `transport` defaults to `auto`: the HTTP API when `REVIEW_API_KEY` is set, otherwise the ponytail runner's logged-in CLI. GitHub Actions without that key still skips. | `REVIEW_API_KEY` and a `model` (or `REVIEW_MODEL`) for the backup HTTP prompt. `REVIEW_TRANSPORT` (`auto`, `api`, `agent`) overrides `transport`. |
| `sarif` | Any tool that emits SARIF: semgrep, CodeQL, eslint... `command` may use `{base}` and `{head}`; `requires` names a binary that must exist; `output` reads a file instead of stdout. | the tool |

Use a different model family for `llm` than the one writing the code, so the reviewers do not
share blind spots. Ponytail's model is `reviewers.ponytail.model` or `PONYTAIL_MODEL`. On the
agent transport, `reviewers.llm.model` or `REVIEW_MODEL` is passed as `--model` when set.

## CI

`peneira init` writes four workflows that call the composite action in this repo:

| Workflow | Runs | Required check? |
|---|---|---|
| `peneira.yml` | `peneira ci policy`: labels, Review guide comment, fails on blocking rules | yes |
| `peneira-reviewers.yml` | `peneira ci reviewers`: every applicable reviewer; findings stored hidden for triage | no (advisory) |
| `ci-checks.yml` | lint, typecheck, tests, gitleaks, npm audit | yes |
| `peneira-metrics.yml` | weekly metrics, optional Slack | no |

`peneira init --runner claude|cursor|codex` (default `claude`) writes `reviewers.ponytail.runner`
and a workflow that installs only that CLI. The action input `agent-runner` is `claude`,
`cursor`, `codex`, or `none`. `install-claude-code: true` still means Claude, so workflows
generated before `agent-runner` keep working.

| Runner | CI install | Secret |
|---|---|---|
| `claude` | `npm install -g @anthropic-ai/claude-code` | `ANTHROPIC_API_KEY` |
| `cursor` | `curl https://cursor.com/install -fsS \| bash` | `CURSOR_API_KEY` |
| `codex` | `npm install -g @openai/codex` | `CODEX_API_KEY` |

Secrets: the runner secret above (Codex reads `CODEX_API_KEY`), `REVIEW_API_KEY` (llm in CI;
locally the runner login is used when the key is unset), `LINEAR_API_KEY` (optional),
`REVIEW_METRICS_SLACK_WEBHOOK` (optional). Variables: `REVIEW_PROVIDER`, `REVIEW_MODEL`,
`REVIEW_TRANSPORT`, `PONYTAIL_MODEL`.

The workflows use `leofmds/peneira@v0`. Pin it to a release tag or a commit SHA, and while the
repo is private, allow other repos to use its action in *Settings → Actions → General → Access*.
Fork PRs get no secrets, so reviewers skip in CI; run `peneira <pr>` locally instead.

## Configuration

Three layers, later wins. Objects merge, arrays replace.

1. Product defaults.
2. `~/.peneira/config.json`, created on the first `peneira` run. Yours, on every repo.
3. `.peneira/config.json` in the repo. The team's override.

Most-used keys:

| Key | Default |
|---|---|
| `budget.maxLogicLines` / `maxFiles` / `blockingFor` | 400 / 10 / `ai` |
| `ticket.pattern` / `requiredFor` / `urlTemplate` | `ABC-123` style / `ai` / none (`https://linear.app/x/issue/{id}`) |
| `templateSections.sections` / `requiredFor` | Intent, Assumptions, Out of scope / not done, How it was verified / `ai` |
| `risk.paths` / `risk.addedLinePatterns` | auth, billing, migrations... / DDL, deletes, secrets, eval |
| `ignore`, `categories.foundation`, `categories.tests` | lockfiles and generated / schemas, migrations, types, config / test globs |
| `findings.visibility` | `summary`: the author sees counts until you triage. `full`: everyone sees all findings |
| `triage.linearTeamKey` | none |

Scopes for `blockingFor` / `requiredFor`: `all`, `ai`, `none`. Start with `none` for a week,
then `ai`.

## Review skill

`reviewers.llm.skills` is the preference order. The first name whose `SKILL.md` exists is the reviewer. Peneira looks in `.agents/skills/<name>/`, `.claude/skills/<name>/`, and `.cursor/skills/<name>/`, in the repo first and then under your home directory.

The default list is `code-review`, `requesting-code-review`, and `code-review-and-quality`. To use your own skill on every repo, set the list in `~/.peneira/config.json`:

```json
{ "reviewers": { "llm": { "skills": ["the-judge"] } } }
```

A repo replaces that list by setting `skills` in `.peneira/config.json`. Leaving `skills` out keeps the global list. `skills: []` turns the skill reviewer off and uses the built-in prompt.

```json
{ "reviewers": { "llm": { "skills": ["our-review"] } } }
```

`our-review` is the folder name, so the file is `.agents/skills/our-review/SKILL.md` (or the same path under `.claude/skills` or `.cursor/skills`). If none of the configured skills are installed, peneira says so, prints an install command for a known skill or the expected path for your own, and reviews with the built-in prompt.

## Metrics

`peneira metrics --days 14` (and the weekly workflow): first-pass merge rate, change-request
rounds, time to first review and size for AI-generated vs other PRs. New triage decisions stay
in `.git/peneira/` on the reviewer's machine. The report still counts decisions left in older PR comments.

## Security model

- PR titles, descriptions and diffs are untrusted. Reviewers only read; the llm prompt tells the
model to ignore instructions inside them; ponytail runs with read-only tools.
- Nothing reaches the PR as a review comment without a human decision.
- Tokens are read from the environment or `gh`; peneira never stores them.

## Development

```bash
npm test        # node:test, fixture repos, fake GitHub, fake runner CLIs; no network
```

Layout: `src/commands/*` (CLI commands), `src/reviewers/*` (adapters), `src/policy.mjs` (gate),
`src/triage.mjs` + `src/publish.mjs` (decisions to GitHub objects), `src/github.mjs` (the only
module that talks to the platform), `templates/` (what `init` writes).

## Why the name

In the state of Minas Gerais, coffee goes through machines first: harvesters, dryers, hullers.
Then it goes through the *peneira*, and finally through people who sort the beans by hand
(*catação*) and taste the cup. Code review with AI works best the same way: let the machines
do the volume, and keep the judgment human.
