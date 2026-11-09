# Security policy

## Reporting a vulnerability

Do not open a public issue. Report it privately through
[GitHub private vulnerability reporting](https://github.com/leofmds/peneira/security/advisories/new).

Include the peneira version (`peneira --version`), the reviewer and runner involved, and the
steps to reproduce. Expect a first reply within 7 days.

## Scope

peneira reads GitHub, Linear and LLM API tokens from the environment, and runs agent CLIs
(`claude`, `cursor`, `codex`) over untrusted PR content. In scope, for example:

- a PR title, description or diff that makes a reviewer write files, run commands or leak a token
- anything that posts to a PR without a human triage decision
- tokens written to disk, logs, PR comments or the `.git/peneira/` cache

The design these rely on is in the README's [Security model](README.md#security-model).

## Supported versions

Only the latest release (and the `v0` action tag that points to it) gets fixes.
