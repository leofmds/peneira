# Spec template (paste into the Linear ticket description)

A spec is what gets reviewed *before* any code exists. Keep it to one page.

## Problem
What is wrong or missing today, for whom, and how we know.

## Expected behavior
Describe behavior, not implementation. Use concrete examples.

## Acceptance criteria
Each one must be testable. Prefer Given / When / Then.
- [ ] Given ..., when ..., then ...
- [ ] Given the same event is delivered twice, when it is processed, then only one record exists.

## Out of scope
What this ticket explicitly does not cover.

## Invariants and constraints
Idempotency, ordering, retries / timeouts, tenancy, volume (rows/day, payload size),
latency or cost limits, backwards compatibility, migration / backfill needs.

## Risk
What breaks if this is wrong? Is it reversible? Feature flag?

## Test data
Where realistic data comes from (sample account, fixture set, staging snapshot) and the
nasty cases to include: duplicates, nulls, oversized payloads, partial failure mid-batch.
