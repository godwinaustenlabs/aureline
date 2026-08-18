# 07 — D1 export and retention pruning

**What to build:** Right now every run is written to the Durable Object's own little database and stays there forever. This ticket gives runs a permanent home. When a run finishes, whether it worked or failed, its rows are copied into D1. Once a Durable Object is holding more than 5 completed runs, the oldest ones are deleted from it, because D1 already has them.

**Blocked by:** nothing. 01, 03, 05 and 06 are all merged.

**Status:** done. Built and verified end to end locally.

**Team:** Database Team

## The thing most people get wrong here

There is one DO instance per session (ADR-0005), and each one has its own separate database. So "keep the 5 most recent" means 5 per session, not 5 in the whole system. Two sessions running at once keep 5 each.

This matters when you test. Nine DO instances already exist on this machine from earlier work, each with its own handful of rows. If you make a request and nothing prunes, you are probably looking at a different instance than the one you filled up.

## Decisions already made

1. **The retention limit comes from `config.retentionLimit`.** Not `env.RETENTION_LIMIT`. That var is only the committed fallback if KV is missing (ADR-0008). `runPipeline` already resolves `config` once per invocation and passes it around, so it is already in your hand. Nothing reads `config.retentionLimit` today, this ticket is its first user.
2. **The limit counts runs, not rows.** Keep the 5 most recent completed `p_invoc_id`s, which is up to 10 rows because each run writes a text row and an image row. A run is never half pruned.
3. **Failed runs go to D1 but are never pruned.** Failure history reaches the durable store, and the local rows stay around for debugging. The cost is that DO storage grows with the number of failures. We accept that.
4. **"A completed run" means a run with no failed row in it. Read this one twice.** When the image stage fails, the text row was already settled as `completed` before the failure happened, so the run looks like this:

   ```
   abc12345  text   completed
   abc12345  image  failed
   ```

   Select rows `WHERE status = 'completed'` and that text row matches. Delete it and you have half-pruned a failed run, which destroys the exact failure history decision 3 promises to keep, and leaves ticket 08 debugging a record whose first half is missing.

   So group by `p_invoc_id` first, then keep only the groups where no row is `failed` and none is still `running`. Filter by run, never by row. There is a real example of this shape in the local data already.

   Also: a planner failure produces **one** row, not two, because the image row is never opened. Do not write anything that assumes two rows per run or divides a row count by two.
5. **Sort runs by `MAX(created_at)`, not by the row's own `created_at`.** The two rows of one run are created seconds apart, because the image row only opens after the planner returns. Real numbers from the local data: text row at 1786279592, image row at 1786279603, eleven seconds later. Sorting rows instead of runs interleaves the halves of different runs and you prune the wrong one.
6. **Pruning never touches R2.** The row is exported to D1 before it is deleted, so `image_r2_key` survives in D1 and the image stays reachable. R2 grows without limit. That is a lifecycle-rule problem for a later sprint, not a correctness problem, and deleting the image would leave the D1 row pointing at a 404.
7. **Export happens on both ways out of the pipeline.** `runPipeline` returns in two places, the success return and the catch. Both are a run settling. The failure path is the one people forget, and ticket 08 is built on failed rows reaching D1.
8. **Pruning runs inline, right after the export, in the same request.** It only runs if the export succeeded. No alarm, no queue. The request already took about 12 seconds, so a few more milliseconds is not worth a new mechanism.
9. **"Export confirmed written" means the D1 write returned without throwing.** It does **not** mean rows changed. Because the insert is idempotent, a legitimate re-export changes zero rows. If you gate pruning on `changes > 0`, pruning silently stops working forever after the first retry.
10. **All D1 code lives in `repository/d1.repository.ts`. All pruning lives in `repository/do.repository.ts`,** next to the write functions already there. `pipeline.ts` calls these functions and contains no Drizzle and no SQL. Ticket 03 skipped naming its target file and needed a follow-up refactor to undo it.
11. **D1 reuses `db/schema.ts`.** Same table, same shape, one definition. This also means the JSON columns serialise the same way on both sides, which they would not if someone hand-wrote a second table definition.
12. **The export covers the whole DO, not just the current invocation.** Added during review, after the shapes below were agreed. The original design exported one invocation's rows and then pruned the whole DO, which exports less than it deletes. A run whose export failed and was swallowed by the catch stays in the DO unexported, and a later run's successful export then prunes it away, losing it from both stores. Export and prune now run over the same set, so a successful export means everything prunable is already in D1.
13. **Only settled rows are exported.** `running` is excluded. Two overlapping invocations on one session can leave a half-written row in the DO, and `onConflictDoNothing` never updates, so whichever version of a row lands in D1 first stays there forever. Export a `running` row once and D1 keeps null params, a null cost and a null `completed_at` permanently, with every corrected version silently dropped on conflict.
14. **D1 caps a query at 100 bound parameters.** A multi-row insert binds every column of every row, and `helios_runs` has 11 columns, so nine rows is the ceiling for one statement. Exporting one invocation was two rows and never came close; exporting the whole DO does, so `exportRuns` chunks. Five completed runs alone is 10 rows and 110 parameters, which fails. See https://developers.cloudflare.com/d1/platform/limits/

## Agreed shapes, do not invent your own

Two people touch this ticket and their code has to fit together. These are fixed. If one looks wrong, say so in the group before changing it, not after.

**`db/client.ts`** gains a second client next to the existing `getDb`:

```ts
export function getD1Db(db: D1Database) {
	return drizzle(db, { schema });
}

export type HeliosD1Db = ReturnType<typeof getD1Db>;
```

Note the import is `drizzle-orm/d1`, not `drizzle-orm/durable-sqlite`. Two different drivers over the same schema.

**`repository/d1.repository.ts`** — currently an empty file:

```ts
/** Copies settled rows into D1. Safe to call twice with the same rows. */
export async function exportRuns(d1: HeliosD1Db, rows: HeliosRun[]): Promise<void>;

/** Reads a run's rows back out of D1. Empty array when the run is not there. */
export async function readRun(d1: HeliosD1Db, pInvocId: string): Promise<HeliosRun[]>;
```

`exportRuns` is idempotent through the `id` primary key using Drizzle's `onConflictDoNothing`, not by the caller remembering to check first. `readRun` exists so the export can be verified through code rather than a hand-typed query.

**`repository/do.repository.ts`** gains two functions:

```ts
/** The rows for one invocation. */
export async function getRunRows(db: HeliosDb, pInvocId: string): Promise<HeliosRun[]>;

/** Every row in this DO that has reached a terminal status, for handing to the
 *  exporter. Excludes `running`. */
export async function getSettledRows(db: HeliosDb): Promise<HeliosRun[]>;

/** Deletes completed runs beyond the limit, oldest first, whole runs only.
 *  Failed runs are never touched. Returns how many runs were deleted. */
export async function pruneCompletedRuns(db: HeliosDb, retentionLimit: number): Promise<number>;
```

`getSettledRows` was added during review, per decisions 12 and 13. It is what the exporter takes now. `getRunRows` stays: it is still the read path for one invocation's rows.

**Where the pipeline calls it.** One private helper in `pipeline.ts`, called from both the success return and the catch:

```ts
async function exportAndPrune(db, env, p_invoc_id, retentionLimit) {
	try {
		const rows = await getSettledRows(db);
		await exportRuns(getD1Db(env.DB), rows);
		await pruneCompletedRuns(db, retentionLimit);
	} catch (cause) {
		console.error(`d1 export failed for ${p_invoc_id}:`, describeError(cause));
	}
}
```

Updated during review: this read `getRunRows(db, p_invoc_id)` originally. Decision 12 has the reason. `p_invoc_id` stays in the signature for the log line.

The whole thing is wrapped in one try/catch that logs and carries on. Export is an audit concern. A caller who just waited 12 seconds for their pattern still gets it. This is the same shape `runPipeline`'s existing cleanup uses.

## Who does what

Hashir Rauf takes the infrastructure: the drizzle config, the migration, and getting the table to actually exist. Arham Zahid takes everything in `src/`: the two repositories, the pipeline wiring, and the tests.

**The two of you share no files.** Hashir touches `drizzle.d1.config.ts` and `infrastructure/d1/migrations/`. Arham touches `db/client.ts`, both repository files, `pipeline.ts` and the tests. Nothing overlaps, so start at the same time and do not wait for each other.

Two things worth knowing anyway:

**Writing is independent, proving it works is not.** Arham can write and unit test the whole thing before the table exists, because the tests use a fake database. But nothing can be run against real D1 until Hashir's migration is applied. So expect to finish writing before you can finish verifying, and do not read a green test run as done.

**Arham, do `getD1Db` first.** It is four lines in `db/client.ts` and every other file you write imports it. Getting it in early means the rest compiles as you go.

## Work

- [x] D1 database is provisioned. `helios-d1`, id `fa6c2552-c844-4c9b-8730-8e3108aa4cc8`, bound as `DB` in `wrangler.jsonc` — **Hashir Rauf**
- [x] Add `drizzle.d1.config.ts` next to the existing `drizzle.config.ts`. Same `schema.ts`, but no `driver` and `out: "../../infrastructure/d1/migrations"`. The existing config is locked to `durable-sqlite` and cannot emit both, which is why there are two. One source of truth for the schema, two outputs — **Hashir Rauf** (data-layer conventions)
- [x] Generate the D1 migration and commit it. `wrangler.jsonc:44` already points `migrations_dir` at `../../infrastructure/d1/migrations` and **that directory does not exist yet**. Sanity check the output against `drizzle/0000_curly_wallow.sql`, which is the DO side of the same table and should match column for column, `image_r2_key` included — **Hashir Rauf**
- [x] Apply the migration and confirm the table exists, locally and remote — **Hashir Rauf**
- [x] Add `getD1Db` to `db/client.ts`, per the shape above. Do this first, it is four lines and everything else you write imports it — **Arham Zahid**
- [x] Write `repository/d1.repository.ts`. The file exists but is empty. Two functions, `exportRuns` and `readRun`, per the shapes above — **Arham Zahid** (data layer)
- [x] Make the export idempotent using `onConflictDoNothing` on the `id` primary key. Calling it twice with the same rows must leave one copy, not two, without the caller checking first — **Arham Zahid**
- [x] Add `getRunRows` and `pruneCompletedRuns` to `repository/do.repository.ts`. Oldest first, whole runs only, completed only, never failed — **Arham Zahid**
- [x] Take the retention limit from `config.retentionLimit`. Do not read `env.RETENTION_LIMIT` and do not hardcode 5 — **Arham Zahid**
- [x] Wire `exportAndPrune` into `pipeline.ts` and call it from **both** the success return and the catch. No SQL and no Drizzle in this file — **Arham Zahid** (owns `services/pipeline.ts`)
- [x] A failed export logs and does not fail the run. Break the D1 binding on purpose and confirm a normal request still returns its pattern — **Arham Zahid**
- [x] Pruning only runs after the export returned without throwing. Never gate it on the number of rows changed, see decision 7 — **Arham Zahid**
- [x] Tests with a fake database, so they cost nothing. Cover: `pruneCompletedRuns` keeps exactly the newest N completed runs and deletes whole runs not single rows, `exportRuns` called twice inserts once, and both failure shapes survive pruning. **The two failure shapes are not the same test.** One is a planner failure, a single `failed` text row and no image row. The other is an image failure, a `completed` text row next to a `failed` image row, and it is the one a naive implementation silently half-deletes. A suite that only covers the first shape passes while the bug is live — **Arham Zahid**
- [x] Exported rows are read back from D1 **through `readRun`**, not a hand-typed query. Ticket 03's equivalent box was ticked on a hand-run SQLite query with no read path in code. Do not repeat that — **Hashir Rauf** (review gate). Unticked at review, `readRun` had no callers and no tests. Now covered by the `readRun` round-trip tests in `do.repository.test.ts`
- [x] Confirm end to end that a completed run reaches D1, that a failed run also reaches D1 and is not pruned, and that the oldest run disappears from the DO once the limit is passed — **Hashir Rauf** (review gate). Unticked at first review: remote `helios_runs` was empty, the local table did not exist, and the largest local DO held 3 runs against a limit of 5, so pruning had never fired. Verified afterwards, see below

## Verification without burning the image budget

**Read this before testing.** Tickets 05 and 06 are merged, so every `POST /generate` now makes a real planner call and a real image call, about $0.0019 each. Pruning triggers above 5 runs, so testing it the obvious way would mean a dozen billed image generations for a database ticket.

**Do not generate runs to cross the limit. Lower the limit to meet the runs you already have.**

The DOs on the machine already hold real runs from tickets 05 and 06, including a `failed` one. `retention_limit` is a KV value, so it can be moved for the length of the test:

```
npx wrangler kv key put --binding CONFIG --local retention_limit 1
```

Then **one** `POST /generate` against a session id whose DO already holds several runs. That single billed call exercises everything: the whole DO exports, the older runs reach D1 for the first time, and the prune drops it to one run.

Restore it afterwards:

```
npx wrangler kv key put --binding CONFIG --local retention_limit 5
```

**Check the result through code, not by eye.** The `readRun` gate above exists for this. `wrangler d1 execute --local` is fine for a quick look, but the box is ticked on the test suite.

**Two things that will waste your afternoon:**

- **`wrangler dev` holds the local D1 file open**, so `wrangler d1 migrations apply --local` can appear to succeed while writing nothing. It creates the `d1_migrations` bookkeeping table and stops, and `helios_runs` never appears. Stop the dev server, apply, confirm the table exists, then restart. Confirm with `npx wrangler d1 execute helios-d1 --local --command "select name from sqlite_master where type='table'"`.
- **A failed export is silent by design.** `exportAndPrune` logs and carries on, so if the table is missing you still get your pattern back and nothing looks wrong. The only sign is a `d1 export failed` line in the dev server output. Check the terminal, not the HTTP response.

**Local KV starts empty**, so `retention_limit` falls back to the committed `RETENTION_LIMIT` var of 5 until you put a value in. `npm run config:pull` copies the remote values down.

## Verified end to end

Local, on the `default` DO, `retention_limit` temporarily set to 1 for each step and restored afterwards. Two billed image calls in total across the whole exercise, $0.0038.

**First pass, unexported history.** The DO held three completed runs from tickets 05 and 06, none of them ever exported, and D1 was empty. One `POST /generate` (`ebcc1c09`) left D1 with **8 rows, 4 runs** and the DO with **2 rows, 1 run**. All three older runs reached the durable store for the first time on the back of someone else's request.

That is decision 12 doing its job. Under the original one-invocation export, only `ebcc1c09` would have been copied out and those three would have been deleted unexported, gone from both stores.

**Failed run, no image cost.** Forced by pointing `text_model` at `@cf/does-not-exist/nope`, which fails at the planner and never reaches the image call. `d1b047a6` returned `status: "failed"`, `params: null`, stage prefixed onto the error. The failed row reached D1 (decision 3), stayed in the DO unpruned, and was **one row, not two**, which is the planner-failure shape in decision 4.

**Final pass, everything at once.** Starting from D1 at 9 rows and a DO holding one completed and one failed run, a single `POST /generate` (`df9d1c9e`, $0.0019008):

| | before | after |
|---|---|---|
| D1 | 9 rows | 11 rows |
| DO | 3 rows, 1 completed + 1 failed | 3 rows, 1 completed + 1 failed |

Everything this ticket promises is in those numbers:

- **Idempotency on the live path, not just in a unit test.** Nine existing rows were re-exported and D1 went to 11, not 20. Decision 9 holds against the real D1, and note that a legitimate re-export changed 9 fewer rows than it touched, which is exactly why pruning must never be gated on rows changed.
- **Whole runs, oldest first.** `ebcc1c09` left the DO complete, both rows together. `df9d1c9e` stayed as the single most recent completed run.
- **Failed runs are never pruned.** `d1b047a6` was still there afterwards, exactly as before.
- **Pruning never touches R2 (decision 6).** `ebcc1c09` was deleted from the DO in this pass, and its image still serves: `GET /images/patterns/ebcc1c09-....jpg` returns `HTTP 200`, 425758 bytes, `image/jpeg`. Its D1 row still carries the matching `image_r2_key`, so the durable record and the object still agree after the local copy is gone.

`60d25392` and `2c6643b2` carry a null `image_r2_key`. They predate ticket 06, so no image was ever stored for them. Not a pruning artefact.