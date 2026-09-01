import { eq, sql } from "drizzle-orm";
import type { IrisD1Db } from "../db/client";
import { prompts, type Prompt, type PromptSlot } from "../db/schema.d1";

/**
 * Every statement against the `prompts` table, and the only place any of them
 * is written (AGENTS.md §2).
 *
 * The table lives in D1 alone, so every function here takes a `IrisD1Db` and
 * never the Durable Object's client — the DO has no such table.
 */

/**
 * Every stored prompt, for the engine's per-request read and for the
 * playground's edit screen.
 *
 * One statement rather than one per slot: the table holds a handful of rows, so
 * a request that needs two prompts should cost one round trip, not two. Reading
 * happens per request and is never cached — a Durable Object outlives many
 * requests, so a cached prompt would freeze and an edit would appear to do
 * nothing (ADR-0008, the same reason `config.ts` re-reads KV every time).
 */
export async function listPrompts(d1: IrisD1Db): Promise<Prompt[]> {
	return d1.select().from(prompts);
}

/** One slot's row, or `null` when nothing has been stored for it yet. */
export async function getPrompt(d1: IrisD1Db, slot: PromptSlot): Promise<Prompt | null> {
	const rows = await d1.select().from(prompts).where(eq(prompts.slot, slot));
	return rows[0] ?? null;
}

/**
 * Writes a slot's prompt, creating the row the first time and overwriting it
 * every time after. **This is the whole write surface of the table** — there is
 * no separate create, no update and no delete, because one row per slot means
 * "route to a different prompt" and "edit the prompt" are the same action.
 *
 * `updated_at` is set explicitly on the conflict branch and this is not
 * optional: SQLite has no `ON UPDATE`, so the column's `DEFAULT
 * CURRENT_TIMESTAMP` fires on INSERT only. Leave it out and every edit after
 * the first keeps the original timestamp forever, on the one column whose job
 * is to say when the row last changed.
 *
 * Blank text is refused rather than stored. An empty prompt is not an error the
 * engine can see — it is a billed model call that returns nothing usable, so
 * the cheapest place to stop it is before it is saved.
 */
export async function upsertPrompt(
	d1: IrisD1Db,
	// One object, and the field order mirrors `schema.d1.ts` (AGENTS.md §6).
	edit: { slot: PromptSlot; promptText: string },
): Promise<void> {
	if (edit.promptText.trim().length === 0) {
		throw new Error(`refusing to store an empty prompt for slot "${edit.slot}"`);
	}

	await d1
		.insert(prompts)
		.values({ slot: edit.slot, promptText: edit.promptText })
		.onConflictDoUpdate({
			target: prompts.slot,
			set: { promptText: edit.promptText, updatedAt: sql`CURRENT_TIMESTAMP` },
		});
}
