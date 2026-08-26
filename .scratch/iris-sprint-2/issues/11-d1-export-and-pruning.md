# iris-11: D1 export and retention pruning

**What to build:** copy settled `iris_runs` rows out of the Durable Object's own SQLite into Iris's D1 database, then delete the oldest completed runs from the DO so its storage does not grow forever. In that order, always.

**Objective:** a Durable Object's storage is not a place to keep history. It is small, it is per-session, and nothing outside that DO can query it. D1 is the durable, queryable copy. Pruning is what keeps the DO's storage bounded. The order matters more than either half: pruning before exporting destroys the only copy of the data, and there is no way to notice that until someone goes looking for a run that no longer exists anywhere.

**Final result:** every completed or failed run ends up in `iris-d1` and stays there, the DO holds only the newest few runs, and a failed run is never deleted from either place.

**Blocked by:** iris-02 (the D1 database and its migrations directory), iris-03 (the schema and `getSettledRows`), and **iris-05**, which creates `services/pipeline.ts` and leaves the no-op `exportAndPrune` body this ticket fills in. That file does not exist before iris-05 lands, so the ticket cannot start until then.

**Status:** done, pending review. iris-05 landed long ago and left the no-op `exportAndPrune` body this ticket fills in, so the old `blocked, waiting on iris-05` was stale.

**Owner:** Maaz Bin Asif. **Reviewer:** Hashir Rauf and Arham Zahid, with the D1 migration apply reviewed by Saad Naik.

Owner changed from Arham Zahid to match who actually built it, the same correction iris-09 needed. Arham Zahid moves to the review side rather than off the ticket.

**Duration:** 1 day. **Scheduled:** Mon Aug 24 to Mon Aug 24.

## Read this first

- ADR-0010 in full. It is short and it is the whole rule this ticket implements.
- `apps/agent-helios/src/repository/d1.repository.ts` (38 lines). Two functions and one constant, and the constant's comment explains the arithmetic you have to redo for Iris.
- `apps/agent-helios/src/services/pipeline.ts:71-98`, `exportAndPrune`. Note that it is called on **both** the success and the failure exits of `runPipeline`.
- `apps/agent-helios/src/repository/do.repository.test.ts` (233 lines), for how the pruning boundaries and export idempotency are tested.
- `.scratch/shared-sprint-2/sprint-2-3-conventions.md`, the paragraph on why Iris has its own D1 database and the joint consolidation ticket planned for the end of the sprint.

## Decisions

1. **Export before prune, always, and never a partial export** (ADR-0010). Export the whole set of settled rows, confirm it landed, and only then prune. A partial export followed by a prune loses rows silently.
2. **A `running` row is never exported.** It has not settled, so its status and cost are not final, and `onConflictDoNothing` means the first version of a row to land is the one that stays forever. Exporting a `running` row would freeze it in that state permanently. `getSettledRows` from iris-03 already filters this; do not add a second filter at the call site, because then there are two places to get it wrong.
3. **A failed run is never pruned.** Failures are the runs people actually go looking for. `pruneCompletedRuns` only touches `completed`, and its name says so.
4. **Chunk the insert at seven rows, not nine.** D1 caps a statement at 100 bound parameters, and a multi-row insert binds every column of every row. `iris_runs` has thirteen columns, so seven rows is 91 parameters and eight would be 104. Helios uses nine because `helios_runs` has eleven columns. Do not copy the 9 across.

   **The 7 is derived from the column count, so it is not a constant anyone may leave alone after a schema change.** Adding two columns makes it 15 × 7 = 105 and the chunk size has to drop to 6. This is the reason `width` and `height` go in `model_metadata` rather than becoming columns of their own — see iris-03 decision 9. If a future ticket does add a column, recompute this and update the chunking test.
5. **`onConflictDoNothing`, keyed on the primary key.** The `id` is generated in the DO and travels with the row, so exporting the same row twice conflicts and writes nothing. That is what makes a partway-through failure safe to retry. Note the flip side: it never updates either, which is decision 2's real teeth.
6. **`exportAndPrune` runs on every exit path**, success and failure, in `runPipeline` and in `resumeRun`. A failed run's rows need exporting just as much as a successful one's.
7. **The retention limit comes from `config.retentionLimit`.** Not `env.RETENTION_LIMIT`, and not a hardcoded 5. In Helios's sprint this exact box was unticked at review, so it is called out here.
8. **An export failure must not fail the run.** The run already happened and the money is already spent. Log it and carry on. The rows stay in the DO and the next invocation's export picks them up, because export is idempotent.
9. **Iris's D1 database is its own, not Helios's.** Consolidating the three engines' databases into one is a separate joint ticket at the end of the sprint, after both squads' tables are stable. The reasoning is in `.scratch/shared-sprint-2/sprint-2-3-conventions.md`.
10. **`design_session_id` is what makes the eventual consolidation worth doing.** It travels with every exported row, so a full-pipeline view is already possible today by stitching three queries together, and becomes a real join once the databases are merged.

## Agreed shapes, do not invent your own

```ts
// apps/agent-iris/src/repository/d1.repository.ts

/**
 * D1 caps a query at 100 bound parameters, and a multi-row insert binds every
 * column of every row. `iris_runs` has 13 columns, so seven rows is the most
 * one statement can carry.
 * https://developers.cloudflare.com/d1/platform/limits/
 */
const MAX_ROWS_PER_INSERT = 7;

/** Safe to call twice with the same rows: `id` is generated in the DO and
 *  travels with the row, so a repeat conflicts on the primary key and writes
 *  nothing. Only ever pass rows that have settled. */
export async function exportRuns(d1: IrisD1Db, rows: IrisRun[]): Promise<void>;

/** Reads a run's rows back out of D1. Empty array when the run is not there. */
export async function readRun(d1: IrisD1Db, pipelineId: string): Promise<IrisRun[]>;
```

```ts
// apps/agent-iris/src/services/pipeline.ts
// Export first, prune second. The order is the decision.
export async function exportAndPrune(
  db: IrisDb, env: Env, pipeline_id: string, retentionLimit: number
): Promise<void>;
```

## Work

- [x] Write `src/repository/d1.repository.ts` with `exportRuns` and `readRun`. Reproduce the parameter-cap comment with **Iris's** arithmetic, thirteen columns and seven rows, not Helios's. (**Maaz Bin Asif**)
- [x] Fill in `exportAndPrune`'s body in `services/pipeline.ts`. iris-05 left the call sites in place with a no-op body; replace the body only. (**Maaz Bin Asif**)
- [x] `exportAndPrune` calls `getSettledRows`, then `exportRuns`, then `pruneCompletedRuns`, in that order, with the export awaited to completion before the prune starts (decision 1). (**Maaz Bin Asif**)
- [x] Wrap the whole thing so a failure logs and returns rather than throwing (decision 8). It is called from inside `runPipeline`'s try and from its catch, and a throw from the catch would escape the function. (**Maaz Bin Asif**)
- [x] Pass `config.retentionLimit` through from the caller. Do not read `env` inside the repository or the service (decision 7). (**Maaz Bin Asif**)
- [x] Confirm `exportAndPrune` is called on `runPipeline`'s success exit, on its failure exit, and on `resumeRun`'s exits (decision 6). Grep for the call sites and count them. (**Maaz Bin Asif**)
- [x] Make sure `readRun` has a caller. In Helios's sprint this function shipped with no callers and no tests and was unticked at review. Either wire it into a debug read or cover it in a test that proves a round trip, and say which you did. (**Maaz Bin Asif**)
- [x] Add tests to `do.repository.test.ts` or a new `d1.repository.test.ts` covering: export idempotency (export the same rows twice, row count unchanged); chunking (export fifteen rows and assert they all land, which exercises the seven-row boundary); a `running` row being excluded; a failed run surviving a prune; and the pruning boundary exactly at the limit and one past it. (**Maaz Bin Asif**)
- [x] Write a test asserting the **order**: with a fake that makes the export fail, the prune must not have run. This is the one test that protects ADR-0010's actual rule, as opposed to testing the two halves separately. (**Maaz Bin Asif**)
- [x] Apply the D1 migration to `iris-d1` for real. `npx wrangler d1 migrations apply iris-d1 --remote` from inside `apps/agent-iris`. iris-03 generated it and deliberately left it unapplied. (**Maaz Bin Asif**, with **Saad Naik** on the apply)

### Review gates

- [ ] Confirm `MAX_ROWS_PER_INSERT` is 7 and that the comment shows the arithmetic. A copied 9 works for small exports and fails only once thirteen columns times eight rows crosses 100, which is a bug that waits until there is real history to bite. (**Hashir Rauf**)
- [ ] Confirm the export-then-prune order is enforced by a test, not just by the order of two lines that someone could reorder while tidying up. (**Hashir Rauf**)
- [ ] Confirm `readRun` has a real caller or a real test. (**Hashir Rauf**)
- [ ] Confirm no `running` row can reach `exportRuns`, by reading `getSettledRows`'s `where` clause rather than trusting its name. (**Hashir Rauf**)
- [ ] Confirm the migration applied against `iris-d1` and not `helios-d1`. Check the `migrations_dir` and the database name in `wrangler.jsonc` before the apply, not after. (**Saad Naik**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: zero, if you do it right.** Every test here runs against in-memory SQLite, and the end-to-end check below reuses runs that already happened in iris-08 and iris-09 rather than generating new ones. There is no reason to spend a single call on this ticket.

1. `npm test --workspace=apps/agent-iris` passes, including the order test.
2. Set the retention limit low: `npm run kv:put --workspace=apps/agent-iris retention_limit 2`.
3. Do three runs. Cheapest way: use `GET /runs` to confirm the DO already holds runs from iris-08 and iris-09, rather than generating fresh ones.
4. `curl -s 'http://localhost:8787/runs' | jq '.runs | length'`. The DO now holds only the newest two completed runs, plus any failed ones.
5. `npx wrangler d1 execute iris-d1 --remote --command "SELECT pipeline_id, design_session_id, modality, status, cost_usd FROM iris_runs ORDER BY created_at"`. Every run, including the pruned ones and the failed ones, is here.
6. Confirm `design_session_id` is populated on every exported row. That column is the whole reason the eventual consolidation is worth doing, and a null there means the chain is broken.
7. Run the same export twice and confirm the D1 row count does not change.
8. **Put the config back:** `npm run config:pull:iris`.

## Two things that will waste your afternoon

**The dev server holds the local D1 file open.** A migration that will not apply, or a `wrangler d1 execute` that seems to run against nothing, is almost always this. Stop the dev server first. This one trap caught people in both ticket 07 and ticket 08 of Helios's sprint, which is why it is listed here in advance.

**Copying Helios's `MAX_ROWS_PER_INSERT = 9` is the mistake this ticket is most likely to ship.** It is one line, it looks right, all your small tests pass, and it breaks the first time an export carries eight or more rows, which is exactly when there is real history worth not losing. Thirteen columns times eight rows is 104 bound parameters. The chunking test with fifteen rows exists specifically to catch this, so write it with a real count rather than a token two.

## Recorded during the build

- **The chunking test does not actually catch a copied 9, and the ticket was wrong to say it would.** It was written with fifteen rows as instructed, then mutation-tested by setting the constant to 9: all eleven tests still passed. The suite runs against `node:sqlite`, which has no hundred-parameter cap, so fifteen rows land whichever chunk size is in force. What the fifteen-row test really proves is that the chunking loop runs more than once and drops nothing, which is worth having but is not the guard the ticket wanted.

  So `MAX_ROWS_PER_INSERT` and a new `D1_BOUND_PARAMETER_LIMIT` are exported, and a test re-derives the arithmetic from the schema with drizzle's `getTableColumns`: a full chunk must stay at or under 100 bound parameters, and one more row must cross it. That fails on a copied 9 (13 x 9 = 117) and it fails the day someone adds a column without recomputing, which is the failure the constant's comment warns about and nothing else was checking.

- **`services/test-env.ts` set `DB: {}`, and that would have made this ticket ship untested.** The moment `exportAndPrune` had a real body, every pipeline and resume test reached `getD1Db(env.DB)`, `{}.prepare` threw, and `exportAndPrune`'s catch swallowed it exactly as designed. The suite stays green while nothing is ever exported. This is not in the ticket and it is the trap most likely to waste an afternoon here.

  Fixed with `createTestD1()` in `repository/test-db.ts`: a real `D1Database` over in-memory `node:sqlite`, implementing the small surface `drizzle-orm/d1` reaches (`prepare` / `bind` / `run` / `all` / `raw` / `batch`). The `CREATE TABLE` DDL was factored out and is now shared with `createTestDb`, so there is one copy to keep in step with `schema.ts` rather than two. `createFailingD1()` is the deliberate opposite, and one test uses it to prove the swallow is still there.

- **`readRun` is covered by a round-trip test, not by a caller.** The ticket allows either and asks which. `d1.repository.test.ts` exports rows, reads them back by `pipeline_id`, and asserts whole-row equality against the originals, plus one-run scoping and an empty array for an unknown id. Whole-row rather than a field or two, because the JSON columns and the millisecond timestamps are the parts most likely to survive a write and come back wrong.

- **The pruning boundary and the failed-run-survives-a-prune cases were already covered**, in `do.repository.test.ts` from iris-03, along with `getSettledRows` excluding running rows. They are not duplicated in the new file. What the new file adds on that theme is the D1-side half: that a `running` row never reaches D1 when the two functions are composed for real.

- **The order test was mutation-tested.** Swapping the `exportRuns` and `pruneCompletedRuns` lines makes it fail, which is the whole reason it exists: two adjacent lines are exactly what someone reorders while tidying up, and testing the halves separately would never notice.

- **All four call sites confirmed by grep**, unchanged since iris-10: `pipeline.ts:276` and `:316` for `runPipeline`'s two exits, `resume.ts:204` and `:231` for `resumeRun`'s.

- **One new cast in the app**, the `as unknown as D1Database` at the end of `createTestD1`, documented in the same style as the two that were already there. A Workers binding cannot be constructed outside a Worker; asserting it once is what keeps every call site checked against the real type.

- **The live check ran against a real database, and every number was predicted before it ran.** The migration is applied to the remote `iris-d1` (`iris_runs` present, 0 rows) and to the local one. With `retention_limit` at 2, one real `POST /generate` produced exactly the predicted result: D1 went to **27 rows** and the DO down to **23**, with 0 `running` rows exported and 0 null `design_session_id`. All three runs the prune deleted (`0e420c20`, `23bde030`, `r-noimage`) are still in D1, which is the export-then-prune order holding against something other than a test double.

  A second run, deliberately failing at the motif read, proved idempotency: the 27 rows already there re-exported with **zero** duplicate ids and zero duplicate `(pipeline_id, modality)` pairs, and only the 2 new rows were added. That run also exercised `runPipeline`'s **failure** exit, so two of the four call sites are now verified live rather than only in the suite. Its failed rows were not pruned.

  **The rows landed in local D1, not remote.** `npm run dev` is plain `wrangler dev`, so D1, KV and R2 are local emulations while the `AI` binding still bills for real — the ticket's step 5 assumes remote bindings and would read 0 rows. The remote table was created by the same migration, so the schema is identical; what is not proven is that hosted D1 accepts the same statements. Anyone wanting that must run `wrangler dev --remote`, which also means editing production KV.

- **`r-noimage` was on the prune list, and it is worth looking at.** It is a lone `completed` text row with no image sibling, so `pruneCompletedRuns` reads the whole run as completed and deletes it. That is exactly the hazard ADR-0001's two-rows-per-invocation rule exists to prevent: a half-written invocation looks like a success and gets pruned like one. Here it was leftover debug seed data and deleting it was correct, but it is a live demonstration of why the rule is a rule.

- **`wrangler.jsonc` still carries `TODO(iris-02): replace with the real id`** above `database_id`, and the same above the KV namespace id, but both now hold real-looking UUIDs. That is iris-02's box, not this ticket's, so it is flagged rather than fixed here.
