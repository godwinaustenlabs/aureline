import { sql } from "drizzle-orm";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * Tables that live in Iris's **D1 database only**, never in the Durable
 * Object's own SQLite.
 *
 * They are in their own file because `drizzle.config.ts` (DO) and
 * `drizzle.d1.config.ts` (D1) both read `schema.ts`, so anything added there is
 * generated into *both* migrations. A `prompts` table inside the DO would be a
 * separate empty copy per Durable Object instance — and the instance is chosen
 * by `session_id` (ADR-0005), so a prompt written into one would exist for a
 * single user's session and nobody else's. Only `drizzle.d1.config.ts` reads
 * this file.
 */

/**
 * The editable system prompts, one row per slot.
 *
 * This is the live prompt: the engine reads `prompt_text` per request and sends
 * exactly what is stored here, so an edit takes effect on the next request with
 * no deploy. It is what the playground writes to.
 *
 * **One row per slot, always.** No versions, no `active` flag, no candidates —
 * editing overwrites `prompt_text` on that slot's single row, so "routing
 * between prompts" and "editing a prompt" are the same action and there is no
 * switching mechanism to build. Version history is deliberately deferred until
 * the first engine has been tested with this mechanism.
 */
export const prompts = sqliteTable("prompts", {
  id: integer("id").primaryKey(),

  /**
   * Which prompt this row is. Unique, because the one-row-per-slot rule is the
   * whole invariant of this table and the database is what enforces it — an
   * upsert on this constraint is how an edit overwrites rather than inserting a
   * second row.
   *
   * Typed as a union rather than bare `text` so a typo is a compile error
   * instead of a row the engine will never read. The engine prefix is kept even
   * though this table already sits in Iris's own database: it costs nothing and
   * it is what lets these rows merge into one table without collision when the
   * per-engine D1 databases are consolidated.
   */
  slot: text("slot", { enum: ["iris_planner", "iris_color"] }).notNull().unique(),

  /** The prompt itself, sent to the model verbatim. */
  promptText: text("prompt_text").notNull(),

  /**
   * When this row was last written, as SQLite's `YYYY-MM-DD HH:MM:SS` UTC text.
   *
   * **The default only fires on INSERT.** SQLite has no `ON UPDATE`, so an
   * `UPDATE` that does not set this column leaves the original timestamp in
   * place forever — on the one column whose entire job is to say when the row
   * last changed. Every write therefore sets it explicitly; `upsertPrompt` in
   * `repository/prompts.repository.ts` is the only thing that writes here, and
   * it is written that way for this reason.
   */
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** Which prompt a row holds. Every read and write is keyed by one of these. */
export type PromptSlot = (typeof prompts.$inferSelect)["slot"];

export type Prompt = typeof prompts.$inferSelect;
export type NewPrompt = typeof prompts.$inferInsert;
