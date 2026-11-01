## 5. Project invariants (always consider, state in Assumptions)
- Idempotency: the same event / batch processed twice must not duplicate data.
- Retries and timeouts: bounded, with backoff; no retry storms.
- Partial failure: what happens if the process dies mid-batch? Can it resume safely?
- Ordering: do not assume ordering unless the source guarantees it.
- Inputs: nulls, missing fields, duplicates, unexpected types, oversized payloads.
- Tenancy: every query is scoped to the tenant / account.
- Migrations and backfills: reversible, batched, safe to run while old code is live.
- Queries: bounded (LIMIT / pagination / time windows); no unbounded scans in hot paths.

