# Rename: review-gate -> peneira

| Decision | Chosen | Why |
|---|---|---|
| Project name | peneira | Names the tool (the sieve), not the human; distinctive; true origin story (Guaxupé coffee). Cupper was the runner-up: names the human role and collides with "cupping" therapy in searches. |
| Home | github.com/leofmds/peneira (personal profile) | No organization needed while validating; transfer later if it grows. |
| npm name | `peneira`, unscoped | Free on npm; install name survives a future move to an org. |
| Commands | `peneira`, alias `review` | `review 14` stays muscle memory; drop the alias before a public npm release if it collides. |

Renamed: package and bins, `.review-gate/` -> `.peneira/`, PR comment markers `<!-- review-gate:` -> `<!-- peneira:`,
cache `.git/review-gate` -> `.git/peneira`, workflows `peneira*.yml`, default action `leofmds/peneira@v0`,
`REVIEW_GATE_DEBUG` -> `PENEIRA_DEBUG`. Env vars for reviewers (REVIEW_API_KEY, REVIEW_MODEL...) unchanged.

Verified: `npm test` 24/24 (new test: default action ref), actionlint clean on `peneira init` output, no
`review-gate` left outside plans/.
