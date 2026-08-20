import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
} from "drizzle-orm/sqlite-core";

/**
 * Audit log of Iris pipeline invocations. Each invocation produces two rows
 * sharing a pipeline_id: one modality: "text" and one modality: "image"
 * (ADR-0001). The image row duplicates planner_params and motif_ref from its
 * text sibling rather than requiring a join.
 *
 * The two ids are different things and the names say which (AGENTS.md §3):
 *
 * - `pipeline_id` is **one run of Iris**. Re-running the same design produces a
 *   new one, which is how the latest attempt stays identifiable.
 * - `design_session_id` is **the design**, minted upstream and carried unchanged
 *   through every engine. It is what stitches Helios's pattern, Iris's colouring
 *   and Atlas's placement into one story, and it is what makes a full-pipeline
 *   view possible before the per-engine D1 databases are merged. See
 *   docs/iris-runs-conventions.md.
 */
export const irisRuns = sqliteTable("iris_runs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  pipelineId: text("pipeline_id").notNull(),
  designSessionId: text("design_session_id").notNull(),
  modality: text("modality", { enum: ["text", "image"] }).notNull(),
  status: text("status", { enum: ["running", "completed", "failed"] }).notNull(),
  userPrompt: text("user_prompt").notNull(),
  motifRef: text("motif_ref").notNull(),
  plannerParams: text("planner_params", { mode: "json" }).notNull(),
  imageR2Key: text("image_r2_key"),
  costUsd: real("cost_usd"),
  modelMetadata: text("model_metadata", { mode: "json" }).notNull(),
  /**
   * Milliseconds since the epoch, not seconds.
   *
   * `mode: "timestamp_ms"` is the half that matters in TypeScript: it tells
   * Drizzle the stored integer is already milliseconds, so it hands back a
   * `Date` directly instead of multiplying by 1000. Paired with a seconds
   * column it would read every timestamp as 1970.
   *
   * `CAST(unixepoch('subsec') * 1000 AS INTEGER)` is the half that matters in
   * SQL. **There is no `unixepoch('millisecond')`** — SQLite's modifier is
   * `'subsec'` (returning fractional seconds as a float), and an unrecognised
   * modifier does not raise: `unixepoch('millisecond')` evaluates to NULL. On
   * this column that surfaces as a NOT NULL failure on every insert; on a
   * nullable one it would write NULLs silently and never complain. The CAST is
   * what turns the float back into the integer the column is declared as.
   *
   * Seconds are too coarse here: the two rows of one invocation are written
   * milliseconds apart, and `pruneCompletedRuns` orders whole runs by their
   * newest `created_at`. At one-second resolution the ordering between runs in
   * the same second is arbitrary, which is how a prune deletes the wrong run.
   */
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});

export type IrisRun = typeof irisRuns.$inferSelect;
export type NewIrisRun = typeof irisRuns.$inferInsert;
