import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
} from "drizzle-orm/sqlite-core";

/**
 * Audit log of Helios pipeline invocations. Each invocation produces two rows
 * sharing a pipeline_id: one modality: "text" and one modality: "image"
 * (ADR-0001). The image row duplicates planner_params from its text sibling
 * rather than requiring a join.
 *
 * The two ids are different things and the names say which (AGENTS.md §3):
 *
 * - `pipeline_id` is **one run of Helios**. Re-running the same design produces
 *   a new one, which is how the latest attempt stays identifiable. It is not a
 *   Durable Object identifier: one DO accumulates many invocations (ADR-0005),
 *   and the DO is chosen by `session_id`, which never appears in this table.
 * - `design_session_id` is **the design**, minted upstream and carried unchanged
 *   through every engine. It is what stitches Helios's pattern, Iris's colouring
 *   and Atlas's placement into one story, and it is what makes a full-pipeline
 *   view possible before the per-engine D1 databases are merged. See
 *   docs/helios-runs-conventions.md and ADR-HELIOS-0001.
 */
export const heliosRuns = sqliteTable("helios_runs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  pipelineId: text("pipeline_id").notNull(),
  designSessionId: text("design_session_id").notNull(),
  modality: text("modality", { enum: ["text", "image"] }).notNull(),
  status: text("status", {
    enum: ["running", "completed", "failed"],
  }).notNull(),
  userPrompt: text("user_prompt").notNull(),
  plannerParams: text("planner_params", { mode: "json" }).notNull(),
  imageR2Key: text("image_r2_key"),
  costUsd: real("cost_usd"),
  modelMetadata: text("model_metadata", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  /**
   * The classifier's answer: `{ mode: "tile" }` or
   * `{ mode: "motif", garment_part: "front" }`.
   *
   * **Its own column rather than merged into `planner_params`**, because it is
   * not the planner's output. The classifier decides what kind of design this
   * is before the planner runs, and keeping the two apart is what lets
   * `HeliosParamsSchema` stay exactly what it was: no planner-output variant, no
   * `.omit()`, no merge at the validate stage (phase-2-plan §6.2). It is also
   * what the playground reads to group a design's runs by garment part, and what
   * any future cross-engine read would want — a field buried inside a params
   * blob is not something another engine can ask for.
   *
   * **Last in the table, not beside `planner_params` where it belongs
   * logically.** `ALTER TABLE … ADD COLUMN` appends, so every database that
   * reaches this column through a migration has it here — and declaring it
   * elsewhere would leave `schema.ts`, the migrations and `test-db.ts`'s
   * hand-written DDL describing three different tables. Drizzle addresses
   * columns by name so nothing breaks either way; what breaks is a reader's
   * ability to trust that this file says what the table is.
   *
   * `notNull` with `{}` written at insert, rather than nullable. Both rows of an
   * invocation carry it (ADR-0001 keeps them symmetrical), and a run that failed
   * before the classifier finished genuinely has nothing here — `{}` says "not
   * classified", which is a different statement from SQL NULL's "unknown" and
   * matches how `planner_params` already handles the same situation.
   *
   * **`.default({})` is load-bearing, and is the one thing here that is not
   * cosmetic.** `planner_params` has no default because it has existed since the
   * table was created; this column is being added to tables that already hold
   * rows. SQLite refuses `ALTER TABLE … ADD COLUMN … NOT NULL` without a
   * non-null default — *only when the table is not empty*, so the generated
   * migration applies cleanly to a fresh database and fails against every
   * deployed one. Nothing in the test suite would catch that either, because
   * `repository/test-db.ts` builds its table with hand-written `CREATE TABLE`
   * and never runs a migration.
   */
  classification: text("classification", { mode: "json" }).notNull().default({}),
});

export type HeliosRun = typeof heliosRuns.$inferSelect;
export type NewHeliosRun = typeof heliosRuns.$inferInsert;
