# atlas-04: `atlas_runs` schema and DO-local persistence

**What to build:** the `atlas_runs` table, defined once and compiled to both DO-local SQLite and D1, plus the repository layer that is the only code in Atlas allowed to touch it. Also the in-memory test database every later Atlas test suite uses, and the ADR recording why this table has one row per invocation when Helios's and Iris's have two.

**Objective:** Atlas has to record what it placed, what it cost, and which Iris run it came from, on both a successful and a failed run. This table is also the thing shared-03 later merges and shared-02 later joins on, so its columns are not a private decision. The one-row shape is a deliberate departure from ADR-0001 and needs writing down as one, because a future reader comparing the three tables will otherwise assume Atlas simply forgot.

**Final result:** a pipeline can open a run row, settle it, fail it, list runs, and prune old ones, all through named functions with real SQL behind them, tested against a real in-memory SQLite database with no Worker runtime and no native module. And `docs/adr/atlas/0001-...` explains the shape.

**Blocked by:** atlas-02 for the workspace and the drizzle configs. The ADR half also needs shared-04, which creates `docs/adr/atlas/`.

**Status:** ready-for-human.

**Owner:** Hashir Rauf. **Reviewer:** Arham Zahid.

**Duration:** 1 day. **Scheduled:** Thu Aug 20 to Thu Aug 20.

## Read this first

- `.scratch/iris-sprint-2/issues/03-iris-runs-schema-and-do-persistence.md`. This is the same job for the other engine, and most of its decisions carry over. The parts that do **not** carry over are the whole substance of this ticket, so read that file and then read the decisions below against it.
- `apps/agent-helios/src/db/schema.ts` (36 lines) and `db/client.ts` (14 lines).
- `apps/agent-helios/src/repository/do.repository.ts` (276 lines). Twelve exported functions; Atlas needs nine of them, and the three it does not need are the reason for this ticket's ADR.
- `apps/agent-helios/src/repository/test-db.ts` (72 lines) and `do.repository.test.ts` (233 lines).
- ADR-0001, in full. This ticket departs from it and has to argue why.
- `.scratch/atlas-sprint-2/plan.md`, "Database shape", which lists the eleven columns and explains each one.

## Decisions

1. **Twelve columns, one row per invocation.** Not two. ADR-0001's reasoning for one row per modality is that a single status and cost field cannot represent "planner ok, image failed", so two independently billable calls need two independent outcomes. Atlas has exactly one billable call and therefore no partial-success case to represent. A `modality` column here would be a copy of a pattern rather than a reuse of it, and it would always hold the same value. The column count moved from eleven to twelve after this ticket was first written, when the request grew a second reference image (`garment_ref`); see decision 8.
2. **Write the ADR, as `docs/adr/atlas/0001-atlas-has-one-image-call-and-one-audit-row.md`.** It covers both halves of the same reasoning: why there is no text call, and why there is therefore one row. Per shared-04, Atlas's ADRs number from `0001` inside their own directory and are cited as `ADR-ATLAS-0001`.
3. **`source_p_invoc_id` is `notNull`.** Atlas cannot run without a pattern to place. Nullable would invite a row with no traceable origin, and that column is what shared-02 walks and shared-03 joins on.
4. **No `error` column**, matching Helios and Iris. A failure's detail lives in `model_metadata` or in the HTTP response. Adding one would make the three tables diverge for no gain and give the pipeline two places to write the same thing.
5. **`modelMetadata` is `notNull`.** Every Atlas row comes from a real model call, so unlike a nullable field there is no case where there is nothing to record. `costUsd` stays nullable, for a run that fails before the gateway log is readable.
6. **`garmentRegions` holds an `AtlasPlacement`** from atlas-01, as JSON. It is the output-shape equivalent of Helios's `planner_params`: what this run actually did, recorded on the row so reading one row tells you the whole story without a join.
7. **`patternRef` is duplicated onto the row rather than only being reachable through `source_p_invoc_id`**, the same way Helios duplicates `planner_params` onto its image row. Reading one row should tell you what produced it, especially once the databases are merged and the upstream row is in the same place and still needs a join to reach.
8. **`garmentRef` is duplicated onto the row for the same reason as `patternRef` (decision 7).** It is the caller-supplied photo of the garment this run printed onto, `notNull` for the same reason `patternRef` is: Atlas cannot run without one. This is the field that pushed the table from eleven columns to twelve.
9. **The single-row read function is called `getRun`, not `getRunRows`.** iris-03's decision 1 says do not rename a column to feel distinct, and that still holds for the columns. This is different: a plural name on a function that can only ever return one row is a lie that someone will write a loop against.
10. **The table is prefixed `atlas_`** so it cannot collide with the Agents SDK's `cf_agents_*` and `__cf_*` tables, which live in the same DO storage (ADR-0003).
11. **The test database is real SQLite, not a mock.** Node's `node:sqlite` driven through Drizzle's `sqlite-proxy` driver: real SQL, no native module, no Worker runtime, and it stands in for both the DO client and the D1 client because both are Drizzle instances over sqlite-core. Requires Node 24, which the root `engines` field already declares.
12. **`test-db.ts` goes in `repository/` from the start**, not inside a test file. In Helios it had to be lifted out later when the pipeline and resume tests needed it too.

## Agreed shapes, do not invent your own

```ts
// apps/agent-atlas/src/db/schema.ts

/**
 * Audit log of Atlas pipeline invocations. One row per invocation, unlike
 * helios_runs and iris_runs which have two. Atlas has a single billable call
 * and therefore no partial-success case for a modality column to represent.
 * See ADR-ATLAS-0001.
 *
 * garment_ref is the caller-supplied photo of the garment this run printed
 * the pattern onto, duplicated onto the row the same way pattern_ref is.
 *
 * source_p_invoc_id carries the upstream Iris run forward, so a full-pipeline
 * view is possible before the per-engine D1 databases are merged. See
 * docs/sprint-2-3-conventions.md.
 */
export const atlasRuns = sqliteTable("atlas_runs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  pInvocId: text("p_invoc_id").notNull(),
  sourcePInvocId: text("source_p_invoc_id").notNull(),
  status: text("status", { enum: ["running", "completed", "failed"] }).notNull(),
  patternRef: text("pattern_ref").notNull(),
  garmentRef: text("garment_ref").notNull(),
  garmentRegions: text("garment_regions", { mode: "json" }).notNull(),
  imageR2Key: text("image_r2_key"),
  costUsd: real("cost_usd"),
  modelMetadata: text("model_metadata", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  completedAt: integer("completed_at", { mode: "timestamp" }),
});

export type AtlasRun = typeof atlasRuns.$inferSelect;
export type NewAtlasRun = typeof atlasRuns.$inferInsert;
```

```ts
// apps/agent-atlas/src/db/client.ts
// Two factories over one schema, returning different types on purpose so it is
// hard to hand a D1 client to something expecting the DO's storage.
export function getDb(storage: DurableObjectStorage) { ... }   // AtlasDb
export function getD1Db(db: D1Database) { ... }                 // AtlasD1Db
```

The nine repository functions. Helios has twelve; the three Atlas does not need are `startTextRun`, `completeTextRun` and `insertResumedTextRun`, all of which record a planner call that Atlas does not make.

| Function | The moment it records |
|---|---|
| `startRun` | row opened, status `running`, before the image call |
| `completeRun` | row settled with its R2 key, cost, placement and metadata |
| `insertFailedRun` | the rescue insert, for when opening the row is itself what failed |
| `failRunningRuns` | marks this invocation's still-`running` rows `failed`, recording any cost already spent |
| `countResumeAttempts` | how many times one root has been resumed, for atlas-08's spend cap |
| `getRun` | the single row for one `p_invoc_id`, or undefined |
| `listRuns` | every row, for the history view |
| `getSettledRows` | only `completed` and `failed` rows, for the D1 export |
| `pruneCompletedRuns` | deletes all but the newest N completed runs |

## Work

### The ADR

- [x] Write `docs/adr/atlas/0001-atlas-has-one-image-call-and-one-audit-row.md`. State both halves: why there is no text call (the repeat-style decisions already exist upstream in Helios's params, and macro-placement is a fixed vocabulary rather than an open-ended language problem), and why one call means one row. Name what would have to change for the answer to be different, which is Atlas gaining a second independently-billable call. (**Hashir Rauf**)
- [x] Cite ADR-0001 and say plainly that this departs from it, rather than quietly not mentioning it. An ADR that only agrees with its predecessors is not doing its job. (**Hashir Rauf**)
- [x] Follow shared-04's directory and citation scheme. If `docs/adr/atlas/` does not exist yet, that ticket has not landed and this box waits on it. (**Hashir Rauf**)

### The schema

- [x] Write `src/db/schema.ts` exactly as above, including the doc comment. (**Hashir Rauf**)
- [x] Write `src/db/client.ts` with the two factories, returning distinct types (`AtlasDb`, `AtlasD1Db`). That distinction is what stops the two clients being mixed up. (**Hashir Rauf**)
- [x] `npm run db:generate` produces the DO migration into `apps/agent-atlas/drizzle/`. Commit it. It is generated, so never hand-edit it. (**Hashir Rauf**)
- [x] `npm run db:generate:d1` produces the D1 migration into `infrastructure/d1/migrations/atlas/`. Commit it. Same schema file, different target, and this is the only reason two drizzle configs exist. (**Hashir Rauf**)
- [x] Confirm `agent.ts`'s `onStart` calls `migrate(getDb(this.ctx.storage), migrations)`. It runs on every DO wake-up and that is safe, because drizzle tracks what is applied. atlas-02 stubbed this; point it at the real migrations. (**Hashir Rauf**)

### The repository

- [x] Write `src/repository/do.repository.ts` with the nine functions above. **This file is the only code in Atlas allowed to touch `atlas_runs`.** No service, no route, no agent method runs a query directly. (**Hashir Rauf**)
- [x] `failRunningRuns` takes the cost already spent as an argument and writes it onto the row it marks failed. Do not have it write null. The image call bills before the R2 save and the row update, so a failure after the call has to record money that already left the account. (**Hashir Rauf**)
- [x] `insertFailedRun` exists for the case where opening the row is what failed. Without it a failed invocation leaves no row at all, which is worse than Iris's version of this problem: there, a lone completed text row at least looks like something happened. Read the comment above `runImageStage` in `apps/agent-helios/src/services/pipeline.ts` for the original reasoning. (**Hashir Rauf**)
- [x] `getSettledRows` returns only `completed` and `failed`. A `running` row must never reach the export (ADR-0010), and filtering here rather than at the call site means one place to get it right. (**Hashir Rauf**)
- [x] `pruneCompletedRuns` takes the retention limit as an argument. Do not read `env.RETENTION_LIMIT` inside the repository and do not hardcode 5. Config reading belongs in `config.ts` only. This exact box was unticked at review in Helios's sprint. (**Hashir Rauf**)
- [x] `countResumeAttempts` counts by `root` from `model_metadata`, not by `resumed_from`. atlas-08 depends on this and the reason is in that ticket; getting it wrong here makes the spend cap unbounded. (**Hashir Rauf**)
- [x] Do **not** write `startTextRun`, `completeTextRun` or `insertResumedTextRun`. If a later ticket seems to need one, that is a signal Atlas grew a text call, which contradicts ADR-ATLAS-0001 and is a group discussion rather than a quiet addition. (**Hashir Rauf**)

### Tests

- [x] Write `src/repository/test-db.ts` exporting `createTestDb` and `insertRow`, with the `CREATE TABLE atlas_runs` statement carrying all twelve columns, `garment_ref` included. Keep the `node:sqlite` plus `sqlite-proxy` approach and reproduce the comment explaining why it is not a native module. (**Hashir Rauf**)
- [x] Write `src/repository/do.repository.test.ts` covering at minimum: the pruning boundary (exactly N kept, N+1 pruned), `getSettledRows` excluding `running`, a failed run never being pruned, `failRunningRuns` writing the cost through, `countResumeAttempts` counting by root, and `getRun` returning undefined for an unknown id. Adapt Helios's suite rather than writing from scratch. (**Hashir Rauf**)
- [x] `npx tsc --noEmit` and `npm test` both clean from inside `apps/agent-atlas`. (**Hashir Rauf**)

### Review gates

- [ ] Count the columns in the generated migration SQL and confirm there are twelve, and that `source_p_invoc_id`, `pattern_ref`, `garment_ref`, `garment_regions` and `model_metadata` are all `NOT NULL`. A missing `NOT NULL` on `source_p_invoc_id` or `garment_ref` is invisible until a row appears with no traceable origin, and shared-03 stops when it finds one. (**Arham Zahid**)
- [ ] Confirm the `CREATE TABLE` in `test-db.ts` matches the generated migration column for column. If they drift, every test passes against a table that does not exist in production. (**Arham Zahid**)
- [ ] Confirm no query lives outside `do.repository.ts`. `grep -rn "atlasRuns" apps/agent-atlas/src --include=*.ts` should only hit `db/schema.ts`, the repository, and the tests. (**Arham Zahid**)
- [ ] Read the ADR and confirm it argues the departure from ADR-0001 rather than just asserting it. (**Arham Zahid**)
- [ ] Confirm the pruning test asserts the boundary and not just that pruning happened. (**Arham Zahid**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: zero.** Every test here runs against in-memory SQLite. Nothing touches Cloudflare and nothing touches a model.

1. `npm test` from inside `apps/agent-atlas`. All repository tests pass.
2. Read the generated file in `apps/agent-atlas/drizzle/` and confirm the table name is `atlas_runs`. A copy-paste of another engine's schema that forgot the table name still compiles, still generates, and quietly writes into the wrong table name.
3. Start the dev server once, hit any route, and confirm `onStart`'s migration applied without error in the log.
4. `npx wrangler d1 migrations list atlas-d1` from inside `apps/agent-atlas` shows the new migration as pending. Do not apply it yet; atlas-09 owns the export and will apply it then.

## Two things that will waste your afternoon

**Copying Iris's thirteen-column schema and deleting two columns produces a table that is subtly not this one.** Iris has `modality`, `user_prompt` and `planner_params`, which Atlas does not, and Atlas has `pattern_ref`, `garment_ref` and `garment_regions`, which Iris does not. That is five differences, not two. Type the twelve columns from the block above rather than editing Iris's down, and count them in the generated SQL afterwards.

**`crypto.randomUUID()` in `$defaultFn` generates the id in Drizzle rather than in SQLite, and that is deliberate.** The id travels with the row, which is what makes atlas-09's export idempotent: a repeat conflicts on the primary key and writes nothing. If you replace it with a SQLite-side default, the export silently starts inserting duplicates instead of conflicting, and nothing complains.
