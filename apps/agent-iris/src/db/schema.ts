import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
} from "drizzle-orm/sqlite-core";

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
