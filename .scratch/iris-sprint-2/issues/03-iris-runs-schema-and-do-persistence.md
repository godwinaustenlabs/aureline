# iris-03: `iris_runs` schema and DO-local persistence

**What to build:** the `iris_runs` table, defined once and compiled to both DO-local SQLite and D1, plus the repository layer that is the only code in Iris allowed to touch that table. Also the in-memory test database every later Iris test suite will use.

**Objective:** Iris has to record what it did, what it cost, and which Helios run it came from, and it has to do that on both a successful and a failed run. Every stage of the pipeline writes a row at a specific moment, and if those moments are not each their own function, the writes end up scattered through the services and no single place tells you what the audit table actually contains. This ticket is also what makes iris-11's D1 export possible, because the export copies rows this ticket defines.

**Final result:** a pipeline can open a text row, settle it, open an image row, settle or fail it, list runs, and prune old ones, all through named functions with real SQL behind them, tested against a real in-memory SQLite database with no Worker runtime and no native module.

**Blocked by:** iris-02. The app workspace and the drizzle configs have to exist first.

**Status:** ready-for-human.

**Owner:** Hashir Rauf. **Reviewer:** Arham Zahid.

## Read this first

- `apps/agent-helios/src/db/schema.ts` (36 lines) and `db/client.ts` (14 lines). Between them they are the whole pattern this ticket copies.
- `apps/agent-helios/src/repository/do.repository.ts` (276 lines). Twelve exported functions, one per moment the pipeline records. Read the doc comment on each before writing the Iris equivalent.
- `apps/agent-helios/src/repository/test-db.ts` (72 lines) and `do.repository.test.ts` (233 lines).
- `.scratch/iris-sprint-2/plan.md`, the "Database shape" section. It lists the thirteen columns and explains each one that differs from Helios.
- ADR-0001 for why there are two rows per invocation, ADR-0003 for the `iris_` prefix.

## Decisions

1. **Thirteen columns, and the two new ones are `source_p_invoc_id` and `motif_ref`.** Everything else is copied from `helios_runs` with the same name and the same meaning. Do not rename a column to feel distinct. Someone reading both tables should not have to relearn what `p_invoc_id` means.
2. **Two rows per invocation, one `text` and one `image`, sharing one `p_invoc_id`** (ADR-0001). A single status field cannot represent "planner succeeded, image failed", and the two calls bill independently, so they need independent outcomes.
3. **`source_p_invoc_id` is `notNull`.** Iris cannot run without a motif to color, so there is no case where this is absent. Making it nullable would invite a run with no traceable origin.
4. **`motif_ref` is duplicated onto both rows**, the same way `planner_params` is duplicated onto Helios's image row rather than requiring a join. Reading one row should tell you what produced it.
5. **No `error` column.** Helios does not have one. A failure's detail lives in `model_metadata` or in the HTTP response. Adding one here would make the two tables diverge for no gain, and would give the pipeline two places to write the same thing.
6. **The table is prefixed `iris_`** so it cannot collide with the Agents SDK's own `cf_agents_*` and `__cf_*` tables, which live in the same DO storage (ADR-0003).
7. **The test database is real SQLite, not a mock.** Node's `node:sqlite` driven through Drizzle's `sqlite-proxy` driver. That runs real SQL with no native module and no Worker runtime, and it stands in for both the DO client and the D1 client because both are Drizzle instances over sqlite-core. It requires Node 24, which the root `engines` field already declares.
8. **`test-db.ts` goes in `repository/` from the start, not inside a test file.** In Helios it had to be lifted out of `do.repository.test.ts` later, when the pipeline and resume tests needed it too. Skip that step here.

## Agreed shapes, do not invent your own

```ts
// apps/agent-iris/src/db/schema.ts

/**
 * Audit log of Iris pipeline invocations. Each invocation produces two rows
 * sharing a p_invoc_id: one modality: "text" and one modality: "image"
 * (ADR-0001). The image row duplicates planner_params and motif_ref from its
 * text sibling rather than requiring a join.
 *
 * source_p_invoc_id carries the upstream Helios run forward, so a full-pipeline
 * view is possible before the per-engine D1 databases are merged. See
 * docs/sprint-2-3-conventions.md.
 */
export const irisRuns = sqliteTable("iris_runs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  pInvocId: text("p_invoc_id").notNull(),
  sourcePInvocId: text("source_p_invoc_id").notNull(),
  modality: text("modality", { enum: ["text", "image"] }).notNull(),
  status: text("status", { enum: ["running", "completed", "failed"] }).notNull(),
  userPrompt: text("user_prompt").notNull(),
  motifRef: text("motif_ref").notNull(),
  plannerParams: text("planner_params", { mode: "json" }).notNull(),
  imageR2Key: text("image_r2_key"),
  costUsd: real("cost_usd"),
  modelMetadata: text("model_metadata", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  completedAt: integer("completed_at", { mode: "timestamp" }),
});

export type IrisRun = typeof irisRuns.$inferSelect;
export type NewIrisRun = typeof irisRuns.$inferInsert;
```

```ts
// apps/agent-iris/src/db/client.ts
// Two factories over one schema. They return different types on purpose, so it
// is hard to hand a D1 client to something expecting the DO's storage.
export function getDb(storage: DurableObjectStorage) { ... }   // IrisDb
export function getD1Db(db: D1Database) { ... }                 // IrisD1Db
```

The twelve repository functions, matching Helios's names one for one:

| Function | The moment it records |
|---|---|
| `startTextRun` | text row opened, status `running`, before the planner is called |
| `completeTextRun` | planner returned valid params, text row settled with params, metadata and cost |
| `insertResumedTextRun` | a resumed run's text row, carrying the resume markers, no planner call made |
| `startImageRun` | image row opened, status `running`, before the image call |
| `insertFailedImageRun` | the rescue insert, for when opening the image row is itself what failed |
| `completeImageRun` | image row settled with its R2 key and cost |
| `failRunningRuns` | marks this invocation's still-`running` rows `failed`, recording any cost already spent |
| `countResumeAttempts` | how many times one root brief has been resumed, for the spend cap |
| `getRunRows` | every row for one `p_invoc_id` |
| `listRuns` | every row, for the history view |
| `getSettledRows` | only `completed` and `failed` rows, for the D1 export |
| `pruneCompletedRuns` | deletes all but the newest N completed runs |

## Work

- [ ] Write `src/db/schema.ts` exactly as above, including the doc comment. (**Hashir Rauf**)
- [ ] Write `src/db/client.ts` with the two factories. They must return distinct types (`IrisDb`, `IrisD1Db`), which is what stops the two clients being mixed up. (**Hashir Rauf**)
- [ ] `npm run db:generate` produces the DO migration into `apps/agent-iris/drizzle/`. Commit it. It is generated, so never hand-edit it. (**Hashir Rauf**)
- [ ] `npm run db:generate:d1` produces the D1 migration into `infrastructure/d1/migrations/iris/`. Commit it. Same schema file, different target, and this is the only reason two drizzle configs exist. (**Hashir Rauf**)
- [ ] Confirm `agent.ts`'s `onStart` calls `migrate(getDb(this.ctx.storage), migrations)`. It runs on every DO wake-up and that is safe, because drizzle tracks what is already applied. iris-02 stubbed this; make sure it now points at the real migrations. (**Hashir Rauf**)
- [ ] Write `src/repository/do.repository.ts` with the twelve functions above. **This file is the only code in Iris allowed to touch `iris_runs`.** No service, no route, no agent method runs a query directly. (**Hashir Rauf**)
- [ ] `failRunningRuns` takes the cost already spent as an argument and writes it onto the row it marks failed. Do not have it write null. The image call bills before the R2 save and the row update, so a failure after the call has to record money that already left the account. (**Hashir Rauf**)
- [ ] `insertFailedImageRun` exists specifically for the case where opening the image row is what failed. Without it, a failed invocation settles as a lone `completed` text row, which looks like a success and which `pruneCompletedRuns` then deletes like any other completed run. Read the comment above `runImageStage` in `apps/agent-helios/src/services/pipeline.ts` for the full explanation. (**Hashir Rauf**)
- [ ] `getSettledRows` returns only `completed` and `failed`. A `running` row must never be able to reach the export (ADR-0010), and filtering here rather than at the call site means there is one place to get it right. (**Hashir Rauf**)
- [ ] `pruneCompletedRuns` takes the retention limit as an argument. Do not read `env.RETENTION_LIMIT` inside the repository and do not hardcode 5. Config reading belongs in `config.ts` only. This exact box was unticked at review in Helios's sprint. (**Hashir Rauf**)
- [ ] Write `src/repository/test-db.ts` exporting `createTestDb` and `insertRow`, with the `CREATE TABLE iris_runs` statement carrying all thirteen columns. Keep the `node:sqlite` plus `sqlite-proxy` approach and reproduce the comment explaining why it is not a native module. (**Hashir Rauf**)
- [ ] Write `src/repository/do.repository.test.ts`. It must cover, at minimum: the pruning boundary (exactly N kept, N+1 pruned), that `getSettledRows` excludes `running`, that a failed run is never pruned, that `failRunningRuns` writes the cost through, and that `countResumeAttempts` counts by root. Adapt Helios's suite rather than writing from scratch. (**Hashir Rauf**)
- [ ] `npx tsc --noEmit` and `npm test` both clean from inside `apps/agent-iris`. (**Hashir Rauf**)

### Review gates

- [ ] Count the columns in the generated migration SQL and confirm there are thirteen, and that `source_p_invoc_id` and `motif_ref` are both `NOT NULL`. A missing `NOT NULL` here is invisible until a row shows up with no traceable origin. (**Arham Zahid**)
- [ ] Confirm the `CREATE TABLE` in `test-db.ts` matches the generated migration column for column. If they drift, every test passes against a table that does not exist in production. (**Arham Zahid**)
- [ ] Confirm no query lives outside `do.repository.ts`. `grep -rn "irisRuns" apps/agent-iris/src --include=*.ts` should only hit `db/schema.ts`, the repository, and the tests. (**Arham Zahid**)
- [ ] Confirm the pruning test actually asserts the boundary and not just that pruning happened. (**Arham Zahid**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: zero.** Every test in this ticket runs against in-memory SQLite. Nothing touches Cloudflare and nothing touches a model.

1. `npm test` from inside `apps/agent-iris`. All repository tests pass.
2. Read the generated file in `apps/agent-iris/drizzle/` and confirm the table name is `iris_runs`, not `helios_runs`. A copy-paste of Helios's schema that forgot the table name still compiles, still generates, and quietly writes into the wrong table name.
3. Start the dev server once and hit any route, then confirm `onStart`'s migration applied without error in the log.
4. `npx wrangler d1 migrations list iris-d1` from inside `apps/agent-iris` shows the new migration as pending. Do not apply it yet; iris-11 owns the export and will need it applied, and applying it now against a database nothing writes to gains nothing.

## Two things that will waste your afternoon

**`crypto.randomUUID()` in `$defaultFn` works in the Worker and in `node:sqlite` tests, but the id is generated by Drizzle rather than by SQLite.** That is deliberate: the id travels with the row, which is what makes iris-11's export idempotent (a repeat conflicts on the primary key and writes nothing). If you replace it with a SQLite-side default, the export silently starts inserting duplicates instead of conflicting.

**The dev server holds the local DO SQLite file open.** A migration that will not apply, or a `wrangler d1` command that seems to do nothing, is almost always this. Stop the dev server first. It cost time in Helios's tickets 07 and 08 both.
