import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { IrisDb } from "../db/client";
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
 *
 * **Returns `IrisDb`, via the one cast in this file.** The proxy driver is a
 * `BaseSQLiteDatabase<"async", …>` and `IrisDb` is a `BaseSQLiteDatabase<"sync",
 * …>`, so the two are not assignable even though the query surface every suite
 * uses is identical and every statement is awaited either way. Asserting it here
 * once is what lets every call site be checked against the real `IrisDb`.
 *
 * The alternative — `as never` at each call site — is what this replaces, and it
 * was not a cosmetic problem: a cast on the `db` argument switches off checking
 * of *every other argument in that call*, which is how a `startImageRun` call
 * passing an incomplete `IrisParams` sat in a green suite (AGENTS.md §4).
 */
export function createTestDb(): IrisDb {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE iris_runs (
			id TEXT PRIMARY KEY,
			pipeline_id TEXT NOT NULL,
			design_session_id TEXT NOT NULL,
			modality TEXT NOT NULL,
			status TEXT NOT NULL,
			user_prompt TEXT NOT NULL,
			motif_ref TEXT NOT NULL,
			planner_params TEXT NOT NULL,
			image_r2_key TEXT,
			cost_usd REAL,
			model_metadata TEXT NOT NULL,
			-- Milliseconds, matching schema.ts's mode: "timestamp_ms". Kept
			-- identical to the generated migration on purpose: nothing enforces
			-- that this DDL matches, and a seconds default here would make every
			-- test read timestamps Drizzle then interprets as milliseconds.
			created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
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
	) as unknown as IrisDb;
}

/** Inserts one row directly, bypassing the do.repository write helpers so
 * each test can set up exact created_at ordering and status combinations. */
export async function insertRow(
	db: IrisDb,
	overrides: Partial<typeof irisRuns.$inferInsert> & { pipelineId: string; modality: "text" | "image" },
) {
	await db.insert(irisRuns).values({
		designSessionId: "helios-run",
		status: "completed",
		userPrompt: "a pattern",
		motifRef: "motif-key",
		plannerParams: {},
		modelMetadata: {},
		...overrides,
	});
}
