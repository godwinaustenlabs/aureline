import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
} from "drizzle-orm/sqlite-core";

/**
 * Audit log of Helios pipeline invocations. Each invocation produces two
 * rows sharing a p_invoc_id: one modality: "text" and one modality: "image"
 * (ADR-0001). The image row duplicates planner_params from its text
 * sibling rather than requiring a join.
 */
export const heliosRuns = sqliteTable("helios_runs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  pInvocId: text("p_invoc_id").notNull(),
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
