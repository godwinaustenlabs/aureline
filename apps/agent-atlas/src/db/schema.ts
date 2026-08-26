import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
} from "drizzle-orm/sqlite-core";

/**
 * Audit log of Atlas pipeline invocations. **One row per invocation**, unlike
 * helios_runs and iris_runs which have two. Atlas has a single billable call
 * and therefore no partial-success case for a modality column to represent.
 * See ADR-ATLAS-0001.
 *
 * The two ids are different things and the names say which (AGENTS.md §3):
 *
 * - `pipeline_id` is **one run of Atlas**. Re-running the same design produces
 *   a new one, which is how the latest attempt stays identifiable.
 * - `design_session_id` is **the design**, minted upstream and carried
 *   unchanged through every engine. It is what stitches Helios's pattern,
 *   Iris's colouring and Atlas's placement into one story, and it is what makes
 *   a full-pipeline view possible before the per-engine D1 databases are
 *   merged.
 *
 * `pattern_ref` and `garment_ref` are both duplicated onto the row rather than
 * only being reachable by a join: reading one row should tell you what produced
 * it, and what it printed onto.
 *
 * The table is prefixed `atlas_` because the Agents SDK keeps its own tables
 * (cf_agents_*, __cf_*) in this same SQLite database (ADR-0003).
 */
export const atlasRuns = sqliteTable("atlas_runs", {
  // Minted here in Drizzle rather than by SQLite, deliberately: the id travels
  // with the row, which is what makes the D1 export idempotent. A repeat
  // conflicts on the primary key and writes nothing. Replace this with a
  // SQLite-side default and the export silently starts inserting duplicates.
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  pipelineId: text("pipeline_id").notNull(),
  // notNull: Atlas never mints one, so a request without it is refused before
  // a row exists. A run that cannot be traced back to a design is worse than a
  // run that did not happen — it still spends money and still lands here.
  designSessionId: text("design_session_id").notNull(),
  status: text("status", {
    enum: ["running", "completed", "failed"],
  }).notNull(),
  patternRef: text("pattern_ref").notNull(),
  garmentRef: text("garment_ref").notNull(),
  // Holds an AtlasPlacement (packages/shared-types/src/v1/atlas.ts): what this
  // run actually did, so reading one row tells the whole story. The output-shape
  // equivalent of helios_runs.planner_params. Typed `unknown` on the way back —
  // always re-validate it through AtlasPlacementSchema rather than trusting it.
  garmentRegions: text("garment_regions", { mode: "json" }).notNull(),
  imageR2Key: text("image_r2_key"),
  // Nullable, for a run that fails before the gateway log is readable.
  costUsd: real("cost_usd"),
  // notNull: every Atlas row comes from a real model call, so unlike costUsd
  // there is no case where there is nothing to record. Also carries the resume
  // markers (root, resumed_from, attempt), because this is the only row there is.
  modelMetadata: text("model_metadata", { mode: "json" }).notNull(),
  /**
   * Milliseconds since the epoch, not seconds. Adopted from `iris_runs`, whose
   * comment records why — the reasoning applies here with one extra edge.
   *
   * `mode: "timestamp_ms"` is the half that matters in TypeScript: it tells
   * Drizzle the stored integer is already milliseconds, so it hands back a
   * `Date` directly instead of multiplying by 1000. Paired with a seconds
   * column it would read every timestamp as 1970.
   *
   * `CAST(unixepoch('subsec') * 1000 AS INTEGER)` is the half that matters in
   * SQL. **There is no `unixepoch('millisecond')`** — SQLite's modifier is
   * `'subsec'`, and an unrecognised modifier does not raise:
   * `unixepoch('millisecond')` evaluates to NULL. On this NOT NULL column that
   * surfaces as a failure on every insert; on a nullable one it would write
   * NULLs silently. The CAST turns the float back into an integer.
   *
   * Seconds are too coarse. `pruneCompletedRuns` orders runs by `created_at`,
   * and at one-second resolution two runs made in the same second sort
   * arbitrarily — which is how a prune deletes the wrong one. Atlas is more
   * exposed to this than Iris, not less: one row per invocation means there is
   * no second row's timestamp to break the tie.
   */
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`),
  // Set when the row settles, on success AND failure.
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});

export type AtlasRun = typeof atlasRuns.$inferSelect;
export type NewAtlasRun = typeof atlasRuns.$inferInsert;
