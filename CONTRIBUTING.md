# Contributing

Bug reports and PRs are welcome. For a larger change, open an issue first so we can agree on
the approach.

## Setup

```bash
git clone https://github.com/leofmds/peneira && cd peneira
npm install                  # dev tools only (typescript); peneira has no runtime dependencies
npm test                     # no network: fixture repos, fake GitHub, fake runner CLIs
npm run typecheck
node bin/peneira.mjs 14 --dry-run   # try it on a real PR without writing to GitHub
```

[CLAUDE.md](CLAUDE.md) describes the architecture, the key contracts (finding, reviewer
adapter, PR state store, config) and the test fixtures. It is written for coding agents and
is just as useful for people.

## Rules

- No runtime dependencies. Use Node's standard library.
- Plain ESM `.mjs`, no build step. Fix type errors with JSDoc or defaults, not `// @ts-ignore`.
- Commands take `io`, `env`, `cwd` and `fetchImpl` as parameters. Don't read globals; the
  tests depend on that injection.
- `src/github.mjs` is the only module that calls the GitHub API. New endpoints need a route
  in `fakeGitHub()` in `test/helpers.mjs`.
- Behavior changes come with a test. Changes to flags, config keys or env vars also update
  `README.md`, and user-visible changes get a line under "Unreleased" in `CHANGELOG.md`.

## Security issues

Don't open a public issue; see [SECURITY.md](SECURITY.md).
