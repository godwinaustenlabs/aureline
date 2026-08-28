# ADR-HELIOS-0001: `pipeline_id` and a required `design_session_id`

**Status:** accepted.

## Context

Helios was the first engine, and it named its run id `p_invoc_id` at a time when there was only one engine and nothing downstream to connect to. Iris and Atlas were built later against a settled vocabulary and both use `pipeline_id` for one run of one engine and `design_session_id` for the design that run belongs to (AGENTS.md §3).

That left Helios as the only engine with a different name for the same thing and the only one with no cross-engine design id at all. The chain the naming exists to support was therefore broken at its first link: given an Iris run, there was no column anywhere that connected it to the Helios pattern it coloured. `apps/frontend` had already begun reading a `design_session_id` off Helios results and minting one it had no way to send.

Separately, five row-opening functions took their arguments as a line-up of positional strings. Adding a third adjacent string to functions that already took two is precisely the shape AGENTS.md §6 exists to forbid, and the shape behind this engine's own runaway-image incident.

## Decision

**Rename `p_invoc_id` to `pipeline_id` throughout**, and add `design_session_id` as the third column of `helios_runs`, `NOT NULL`, immediately after `pipeline_id` — the same position Iris gives it.

**`design_session_id` is required on `POST /generate`, with no alias and no fallback.** Helios does not mint one, does not default one, and does not accept the old name in its place. A request without it is a 400. A run that cannot be traced back to a design is worse than a run that did not happen, because it still spends money and still lands in the audit table. `POST /resume` does not take one: a resume copies it off the run being resumed, so a retry belongs to the design it is retrying.

**Both `0000` migrations are regenerated rather than extended with a `0001`.** `design_session_id` is `NOT NULL` with no default, which SQLite cannot add to a non-empty table. Helios's audit rows are disposable at this stage, so a clean break costs less than a migration path for data nobody needs. This is what the equivalent Iris rename did.

**Every row-opening function takes one `RowSeed` object** whose field order mirrors `schema.ts`. `completeTextRun` and `failRunningRuns` stay positional, because their arguments are of distinct types and §6 does not bite.

## Consequences

`MAX_ROWS_PER_INSERT` in `d1.repository.ts` **drops from 9 to 8.** It is derived from the column count against D1's 100-bound-parameter cap: 11 columns allowed 9 rows per statement, 12 columns allow 8, and `12 x 9 = 108` would have breached it. This is the most dangerous line in the change, because `exportAndPrune` swallows what it catches by design, so a wrong value fails silently in production — every run still returns `completed` while nothing reaches D1, and only once a session has eight or more settled rows. `d1.repository.test.ts` now asserts the invariant against the column count Drizzle reports, so adding a 13th column fails a test rather than ending the export.

The AI Gateway log metadata key changes from `p_invoc_id` to `pipeline_id`. Log rows written before this deploy carry the old key, so a dashboard filter spanning the change needs both.

**The regenerated `0000` is a bare `CREATE TABLE` with no `IF NOT EXISTS`.** Anything that applied the old `0000` throws "table already exists" on the new one, and for a Durable Object that happens inside `onStart`, so existing sessions break rather than merely losing history. Before the next deploy, a human must:

1. Delete the `agent-helios` Worker, which takes the `HeliosAgent` namespace and all its DO storage with it. The R2 bucket and the KV namespace are separate resources and survive untouched, and there are no secrets to restore. Note the bucket is now `images-bucket`, shared with Iris and Atlas, so deleting objects from it is not a Helios-only decision.
2. Against `helios-d1`, `DROP TABLE helios_runs;` and delete the `0000_abnormal_sway` row from `d1_migrations`. Without the second statement wrangler still believes the old migration is applied and skips the new one.
3. Redeploy, then apply the D1 migration.

This discards the exported audit rows in both stores, which is the accepted cost of the clean break above.

## What this does not do

`HeliosResult` stays an interface rather than becoming a zod schema the way `IrisResultSchema` is. That is a real improvement and it is not this change.

The object parameters close the *positional* bug class, not every mix-up. Written as shorthand — `{ pipelineId, designSessionId }` — there is no order to get wrong, which is the protection. Two same-typed values can still be mapped to each other's fields by someone writing `pipelineId: designSessionId` deliberately; no type can catch that. A misnamed or missing field is a compile error.
