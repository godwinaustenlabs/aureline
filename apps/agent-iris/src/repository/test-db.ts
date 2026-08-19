import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "../db/schema";
import { irisRuns } from "../db/schema";

/**
 * A real in-memory SQLite database behind the same Drizzle schema the DO and
 * D1 both use. Both `IrisDb` and `IrisD1Db` are `drizzle-orm` instances over
 * sqlite-core, so this stands in for either without a Worker runtime.
 *
 * Node's own `node:sqlite` rather than a native module, driven through the
 * `sqlite-proxy` driver because Drizzle has no `node:sqlite` driver of its own.
 * That keeps a compiled dependency and its install script out of a project
 * whose runtime is Workers and never uses SQLite from Node at all. Requires
 * Node 24, which the root `engines` field declares.
 *
 * Lives in `repository/` from the start, not inside a test file, so every
 * suite that needs a database shares one definition.
 */
export function createTestDb() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE iris_runs (
			id TEXT PRIMARY KEY,
			p_invoc_id TEXT NOT NULL,
			source_p_invoc_id TEXT NOT NULL,
			modality TEXT NOT NULL,
			status TEXT NOT NULL,
			user_prompt TEXT NOT NULL,
			motif_ref TEXT NOT NULL,
			planner_params TEXT NOT NULL,
			image_r2_key TEXT,
			cost_usd REAL,
			model_metadata TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			completed_at INTEGER
		);
	`);

	return drizzle(
		// sqlite-proxy hands over raw SQL and wants each row back as an array of
		// values in select order. `node:sqlite` returns objects, so `columns()`
		// supplies the order to map them by.
		async (sql, params, method) => {
			const stmt = sqlite.prepare(sql);
			const bound = params as Parameters<typeof stmt.all>;

			if (method === "run") {
				stmt.run(...bound);
				return { rows: [] };
			}

			const names = stmt.columns().map((column) => column.name);
			const rows = stmt.all(...bound).map((row) => names.map((name) => (row as Record<string, unknown>)[name]));

			return { rows: method === "get" ? (rows[0] ?? []) : rows };
		},
		{ schema },
	);
}

/** Inserts one row directly, bypassing the do.repository write helpers so
 * each test can set up exact created_at ordering and status combinations. */
export async function insertRow(
	db: ReturnType<typeof createTestDb>,
	overrides: Partial<typeof irisRuns.$inferInsert> & { pInvocId: string; modality: "text" | "image" },
) {
	await db.insert(irisRuns).values({
		sourcePInvocId: "helios-run",
		status: "completed",
		userPrompt: "a pattern",
		motifRef: "motif-key",
		plannerParams: {},
		modelMetadata: {},
		...overrides,
	});
}
