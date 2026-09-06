/**
 * Every statement the playground runs against an engine's `prompts` table, and
 * the only place any of them is written.
 *
 * Raw D1 rather than Drizzle, deliberately. This is three statements against a
 * four-column table; pulling `drizzle-orm` into the playground to express them
 * would add a dependency, a schema copy and a second definition of the table
 * that nothing keeps in step with the engines'. The column names below are the
 * contract, and they are checked by `prompts.test.ts` against a real SQLite
 * table created from the same DDL the migration produces.
 */

/** The engines whose prompts this playground can edit. */
export type EngineName = "iris" | "helios";

/**
 * Which slots belong to which engine.
 *
 * This is a whitelist, not a hint. Without it a request could write any slot
 * string into either database, producing rows no engine will ever read — an
 * edit that appears to save and then silently does nothing, which is the single
 * most confusing failure this screen could have.
 *
 * It mirrors the `slot` union in each engine's `db/schema.d1.ts`. Nothing
 * enforces the match across workspaces, so a slot added there is added here.
 */
export const ENGINE_SLOTS = {
	iris: ["iris_planner", "iris_color"],
	helios: ["helios_planner", "helios_classifier", "helios_research"],
} as const satisfies Record<EngineName, readonly string[]>;

/** Matches `MIN_PROMPT_LENGTH` in each engine's `config.ts`. A shorter row is
 *  ignored by the engine at read time, so saving one would look like a save that
 *  did nothing. Refuse it here instead, where the person can see why. */
export const MIN_PROMPT_LENGTH = 20;

/** One slot as the editor sees it. `promptText` is null when no row exists yet. */
export interface PromptView {
	slot: string;
	promptText: string | null;
	updatedAt: string | null;
}

export function isEngineName(value: unknown): value is EngineName {
	return value === "iris" || value === "helios";
}

export function isSlotOf(engine: EngineName, slot: unknown): boolean {
	return typeof slot === "string" && (ENGINE_SLOTS[engine] as readonly string[]).includes(slot);
}

/**
 * Every slot the engine has, whether or not it has a row yet.
 *
 * Returning the unseeded slots as `promptText: null` is what lets the screen
 * render one box per slot from the start. A list of only the rows that exist
 * would show nothing at all before the first save, and there would be no way to
 * create the first one.
 */
export async function listPrompts(db: D1Database, engine: EngineName): Promise<PromptView[]> {
	const { results } = await db
		.prepare("SELECT slot, prompt_text, updated_at FROM prompts")
		.all<{ slot: string; prompt_text: string; updated_at: string }>();

	const stored = new Map(results.map((row) => [row.slot, row]));

	return ENGINE_SLOTS[engine].map((slot) => {
		const row = stored.get(slot);
		return {
			slot,
			promptText: row?.prompt_text ?? null,
			updatedAt: row?.updated_at ?? null,
		};
	});
}

/**
 * Writes a slot's prompt, creating the row the first time and overwriting it
 * every time after. The whole write surface — no create, no delete, because one
 * row per slot means editing and routing are the same action.
 *
 * `updated_at` is set explicitly on the conflict branch, and that is not
 * optional: SQLite has no `ON UPDATE`, so the column's `DEFAULT
 * CURRENT_TIMESTAMP` fires on INSERT only. Leave it out and every edit after the
 * first keeps the original timestamp forever.
 */
export async function savePrompt(db: D1Database, slot: string, promptText: string): Promise<string | null> {
	await db
		.prepare(
			`INSERT INTO prompts (slot, prompt_text) VALUES (?, ?)
			 ON CONFLICT(slot) DO UPDATE SET prompt_text = excluded.prompt_text, updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(slot, promptText)
		.run();

	// Read back rather than reporting the time this worker thinks it is: the
	// value on screen after a save should be the one actually stored.
	const row = await db
		.prepare("SELECT updated_at FROM prompts WHERE slot = ?")
		.bind(slot)
		.first<{ updated_at: string }>();

	return row?.updated_at ?? null;
}
