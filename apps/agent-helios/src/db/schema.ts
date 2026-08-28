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
});

export type HeliosRun = typeof heliosRuns.$inferSelect;
export type NewHeliosRun = typeof heliosRuns.$inferInsert;
