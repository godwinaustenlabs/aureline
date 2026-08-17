# atlas-09: D1 export and retention pruning

**What to build:** copy settled `atlas_runs` rows out of the Durable Object's own SQLite into Atlas's D1 database, then delete the oldest completed runs from the DO so its storage does not grow forever. In that order, always.

**Objective:** a Durable Object's storage is not a place to keep history. It is small, it is per-session, and nothing outside that DO can query it. D1 is the durable, queryable copy, and it is what shared-02's full-pipeline view and shared-03's consolidation both read. Pruning keeps the DO bounded. The order matters more than either half: pruning before exporting destroys the only copy, and nothing notices until someone goes looking for a run that no longer exists anywhere.

**Final result:** every completed or failed run ends up in `atlas-d1` and stays there, the DO holds only the newest few runs, and a failed run is never deleted from either place.

**Blocked by:** atlas-02 (the D1 database and its migrations directory) and atlas-04 (the schema and `getSettledRows`).

**Status:** ready-for-human.

**Owner:** Arham Zahid. **Reviewer:** Hashir Rauf, with the D1 migration apply reviewed by Saad Naik.

## Read this first

- `.scratch/iris-sprint-2/issues/11-d1-export-and-pruning.md`. Same job for the other engine, written by the same person. Every decision transfers except the chunk size, which is the one thing this ticket must not copy.
- ADR-0010 in full. It is short and it is the whole rule this ticket implements.
- `apps/agent-helios/src/repository/d1.repository.ts` (38 lines). Two functions and one constant, and the constant's comment explains the arithmetic you have to redo.
- `apps/agent-helios/src/services/pipeline.ts:71-98`, `exportAndPrune`. Note it is called on **both** the success and the failure exits.
- `docs/sprint-2-3-conventions.md`, on why Atlas has its own D1 database and the consolidation ticket planned for the end.

## Decisions

1. **Export before prune, always, and never a partial export** (ADR-0010). Export the whole set of settled rows, confirm it landed, then prune. A partial export followed by a prune loses rows silently.
2. **A `running` row is never exported.** It has not settled, so its status and cost are not final, and `onConflictDoNothing` means the first version of a row to land is the one that stays forever. Exporting a `running` row would freeze it in that state permanently. `getSettledRows` from atlas-04 already filters this; do not add a second filter at the call site.
3. **A failed run is never pruned.** Failures are the runs people actually go looking for. `pruneCompletedRuns` only touches `completed`.
4. **Chunk the insert at eight rows.** D1 caps a statement at 100 bound parameters, and a multi-row insert binds every column of every row. `atlas_runs` has twelve columns (it grew from eleven after atlas-04 added `garment_ref`), so eight rows is 96 parameters and nine would be 108. This no longer matches Helios's nine (`helios_runs` has eleven columns) and it still deliberately differs from Iris's seven, because `iris_runs` has thirteen columns. Write the arithmetic in the comment so nobody "fixes" it to match either other engine.
5. **`onConflictDoNothing`, keyed on the primary key.** The `id` is generated in the DO and travels with the row, so exporting the same row twice conflicts and writes nothing. That is what makes a partway failure safe to retry. The flip side is that it never updates either, which is decision 2's real teeth.
6. **`exportAndPrune` runs on every exit path**, success and failure, in `runPipeline` and in `resumeRun`. A failed run's row needs exporting as much as a successful one's.
7. **The retention limit comes from `config.retentionLimit`.** Not `env.RETENTION_LIMIT`, and not a hardcoded 5. In Helios's sprint this exact box was unticked at review.
8. **An export failure must not fail the run.** The run already happened and the money is already spent. Log it and carry on. The rows stay in the DO and the next invocation's export picks them up, because export is idempotent.
9. **Atlas's D1 database is its own, not Helios's or Iris's.** Consolidation is `shared-03`, at the end of the sprint, after both squads' tables are stable.
10. **`source_p_invoc_id` is what makes the eventual consolidation worth doing.** It travels with every exported row, so a full-pipeline view is possible today by stitching three queries together and becomes a real join once the databases are merged. A null in that column is a bug that shared-03 will stop on, so it is worth checking here where it is cheap.

## Agreed shapes, do not invent your own

```ts
// apps/agent-atlas/src/repository/d1.repository.ts

/**
 * D1 caps a query at 100 bound parameters, and a multi-row insert binds every
 * column of every row. `atlas_runs` has 12 columns, so eight rows is the most
 * one statement can carry (96 bound parameters; nine rows would be 108).
 * Helios uses nine because helios_runs has 11 columns, and Iris uses seven
 * because iris_runs has 13 columns. All three numbers come from the same
 * arithmetic applied to a different column count; none of them should be
 * copied onto another engine.
 * https://developers.cloudflare.com/d1/platform/limits/
 */
const MAX_ROWS_PER_INSERT = 8;

/** Safe to call twice with the same rows: `id` is generated in the DO and
 *  travels with the row, so a repeat conflicts on the primary key and writes
 *  nothing. Only ever pass rows that have settled. */
export async function exportRuns(d1: AtlasD1Db, rows: AtlasRun[]): Promise<void>;

/** Reads a run back out of D1. Undefined when it is not there. */
export async function readRun(d1: AtlasD1Db, pInvocId: string): Promise<AtlasRun | undefined>;
```

```ts
// apps/agent-atlas/src/services/pipeline.ts
// Export first, prune second. The order is the decision.
export async function exportAndPrune(
  db: AtlasDb, env: Env, p_invoc_id: string, retentionLimit: number
): Promise<void>;
```

## Work

- [ ] Write `src/repository/d1.repository.ts` with `exportRuns` and `readRun`. Reproduce the parameter-cap comment with **Atlas's** arithmetic, twelve columns and eight rows, and name both Helios's nine and Iris's seven in it so the difference from each is deliberate on the page. (**Arham Zahid**)
- [ ] Fill in `exportAndPrune`'s body in `services/pipeline.ts`. atlas-06 left the call sites in place with a no-op body; replace the body only. (**Arham Zahid**)
- [ ] `exportAndPrune` calls `getSettledRows`, then `exportRuns`, then `pruneCompletedRuns`, in that order, with the export awaited to completion before the prune starts (decision 1). (**Arham Zahid**)
- [ ] Wrap the whole thing so a failure logs and returns rather than throwing (decision 8). It is called from inside `runPipeline`'s try and from its catch, and a throw from the catch would escape the function. (**Arham Zahid**)
- [ ] Pass `config.retentionLimit` through from the caller. Do not read `env` inside the repository or the service (decision 7). (**Arham Zahid**)
- [ ] Confirm `exportAndPrune` is called on `runPipeline`'s success exit, on its failure exit, and on `resumeRun`'s exits (decision 6). Grep for the call sites and count them. (**Arham Zahid**)
- [ ] Make sure `readRun` has a caller. In Helios's sprint this function shipped with no callers and no tests and was unticked at review. Either wire it into a debug read or cover it in a test proving a round trip, and say which you did. (**Arham Zahid**)
- [ ] Add tests covering: export idempotency (export the same rows twice, row count unchanged); chunking (export twenty rows and assert they all land, which exercises the eight-row boundary twice over); a `running` row being excluded; a failed run surviving a prune; and the pruning boundary exactly at the limit and one past it. (**Arham Zahid**)
- [ ] Write a test asserting the **order**: with a fake that makes the export fail, the prune must not have run. This is the one test that protects ADR-0010's actual rule, rather than testing the two halves separately. (**Arham Zahid**)
- [ ] Add an assertion that every exported row has a non-null `source_p_invoc_id` (decision 10). Cheap here, and it is the column shared-02 and shared-03 both depend on. (**Arham Zahid**)
- [ ] Apply the D1 migration to `atlas-d1` for real: `npx wrangler d1 migrations apply atlas-d1 --remote` from inside `apps/agent-atlas`. atlas-04 generated it and deliberately left it unapplied. (**Arham Zahid**, with **Saad Naik** on the apply)

### Review gates

- [ ] Confirm `MAX_ROWS_PER_INSERT` is 8 and that the comment shows the arithmetic and names why both Helios's and Iris's numbers are different. All directions of copying are a real risk this sprint, since the same person writes the Iris and Atlas versions of this ticket. (**Hashir Rauf**)
- [ ] Confirm the export-then-prune order is enforced by a test, not just by the order of two lines someone could reorder while tidying up. (**Hashir Rauf**)
- [ ] Confirm `readRun` has a real caller or a real test. (**Hashir Rauf**)
- [ ] Confirm no `running` row can reach `exportRuns`, by reading `getSettledRows`'s `where` clause rather than trusting its name. (**Hashir Rauf**)
- [ ] Confirm the migration applied against `atlas-d1` and not another engine's. Check `migrations_dir` and the database name in `wrangler.jsonc` before the apply, not after. (**Saad Naik**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: zero, if you do it right.** Every test runs against in-memory SQLite, and the end-to-end check reuses runs that already happened in atlas-07 rather than generating new ones. There is no reason to spend a call on this ticket.

1. `npm test --workspace=apps/agent-atlas` passes, including the order test.
2. Set the retention limit low: `npm run kv:put --workspace=apps/agent-atlas retention_limit 2`.
3. Use `GET /runs` to confirm the DO already holds runs from atlas-07, rather than generating fresh ones.
4. `curl -s 'http://localhost:8787/runs' | jq '.runs | length'`. The DO now holds only the newest two completed runs, plus any failed ones.
5. `npx wrangler d1 execute atlas-d1 --remote --command "SELECT p_invoc_id, source_p_invoc_id, status, cost_usd FROM atlas_runs ORDER BY created_at"`. Every run, including the pruned and the failed ones, is here.
6. Confirm `source_p_invoc_id` is populated on every exported row.
7. Run the same export twice and confirm the D1 row count does not change.
8. **Put the config back:** `npm run config:pull:atlas`.

## Two things that will waste your afternoon

**Copying Iris's `MAX_ROWS_PER_INSERT = 7`, or Helios's `9`, is this ticket's most likely mistake.** Either one "works" in the sense that nothing errors: seven under-chunks and just runs the insert more often than it needs to, and nine over-chunks by two parameters past 96 only if a row somehow grows, which won't happen here but is exactly the kind of thing that looks fine until it doesn't. Atlas used to coincidentally match Helios's nine, back when both tables had eleven columns; adding `garment_ref` broke that coincidence, and this ticket's number now has to come from Atlas's own column count, not from either other engine's.

**The dev server holds the local D1 file open.** A migration that will not apply, or a `wrangler d1 execute` that seems to run against nothing, is almost always this. Stop the dev server first. It caught people in both ticket 07 and ticket 08 of Helios's sprint.
