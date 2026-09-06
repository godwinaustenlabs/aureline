import { DatabaseSync } from "node:sqlite";

/**
 * A `D1Database` that really writes, backed by in-memory SQLite.
 *
 * The DDL below is the one the engines' `0001` migration produces. It is copied
 * rather than imported because the playground does not depend on either engine
 * workspace — which means nothing enforces the match, so a schema change there
 * is a change here (the same trade the engines' own `test-db.ts` makes).
 *
 * A fake that cannot write would turn every failed save into a passing test, so
 * this one writes and the assertions read the rows back.
 *
 * Only the surface `server/prompts.ts` reaches is implemented: `prepare`
 * returning a statement that `bind`s, and `run` / `all` / `first`.
 */
const PROMPTS_DDL = `
	CREATE TABLE prompts (
		id INTEGER PRIMARY KEY,
		slot TEXT NOT NULL UNIQUE,
		prompt_text TEXT NOT NULL,
		updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	);
`;

export function createTestD1(): D1Database {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(PROMPTS_DDL);

	const statement = (sql: string, params: readonly unknown[]) => {
		const bound = params as Parameters<ReturnType<typeof sqlite.prepare>["all"]>;

		return {
			bind: (...next: unknown[]) => statement(sql, next),
			run: async () => {
				sqlite.prepare(sql).run(...bound);
				return { results: [], success: true, meta: {} };
			},
			all: async () => ({ results: sqlite.prepare(sql).all(...bound), success: true, meta: {} }),
			first: async () => sqlite.prepare(sql).all(...bound)[0] ?? null,
			raw: async () => {
				const stmt = sqlite.prepare(sql);
				const names = stmt.columns().map((column) => column.name);
				return stmt.all(...bound).map((row) => names.map((name) => (row as Record<string, unknown>)[name]));
			},
		};
	};

	// The one cast in this file. A real `D1Database` is a Workers runtime binding
	// and cannot be constructed outside a Worker; asserting it here once is what
	// lets every call site be checked against the real type.
	return { prepare: (sql: string) => statement(sql, []) } as unknown as D1Database;
}

/** Writes a row the way the engines' own repository does, for read-path tests. */
export function seed(db: D1Database, slot: string, promptText: string, updatedAt?: string): Promise<unknown> {
	return updatedAt
		? db.prepare("INSERT INTO prompts (slot, prompt_text, updated_at) VALUES (?, ?, ?)").bind(slot, promptText, updatedAt).run()
		: db.prepare("INSERT INTO prompts (slot, prompt_text) VALUES (?, ?)").bind(slot, promptText).run();
}
