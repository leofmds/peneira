# Changelog

All notable changes to peneira. Versions follow [Semantic Versioning](https://semver.org/);
while on 0.x, minor versions may change the CLI or config.

## Releasing

1. Move the "Unreleased" entries under a new version heading and bump `version` in `package.json`.
2. Tag the release: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. Move the `v0` major tag that workflows written by `peneira init` use:
   `git tag -f v0 vX.Y.Z && git push -f origin v0`.

## Unreleased

- Run ponytail through Claude Code, the Cursor agent CLI or Codex (`reviewers.ponytail.runner`, `PENEIRA_RUNNER`).
- New `llm` reviewer with HTTP API and agent transports. On the agent transport it runs the
  first installed review skill and falls back to the bundled `high-signal-review` skill.
- The `llm` reviewer reports only defects the PR introduces, each with a scenario, evidence
  and a fix, and can read code outside the diff.
- `--compare` runs the comparison reviewers. Reviewers whose skill cannot run are skipped.
- Reviewers run in priority order. Duplicate findings on overlapping lines are merged.
- Findings that were already posted stay hidden on `--all`.
- Required PR description sections are read from the repo's PR template.
- The PR link is shown under the review header.
- Typecheck with `tsc --checkJs` (`npm run typecheck`).

## 0.1.0 (2026-11-01)

First release: the `peneira` CLI (resolve the PR, gate, run reviewers, interactive triage,
publish one review), `peneira init` presets and templates, `peneira ci` steps, `peneira metrics`,
and the composite GitHub Action.
