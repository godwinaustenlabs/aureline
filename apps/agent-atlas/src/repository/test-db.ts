import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "../db/schema";
import { atlasRuns } from "../db/schema";
import type { AtlasDb } from "../db/client";

/**
 * A real in-memory SQLite database behind the same Drizzle schema the DO and
 * D1 both use. Both `AtlasDb` and `AtlasD1Db` are `drizzle-orm` instances over
 * sqlite-core, so this stands in for either without a Worker runtime.
 *
 * Node's own `node:sqlite` rather than a native module, driven through the
 * `sqlite-proxy` driver because Drizzle has no `node:sqlite` driver of its own.
 * That keeps a compiled dependency and its install script out of a project
 * whose runtime is Workers and never uses SQLite from Node at all. Requires
 * Node 24, which the root `engines` field declares.
 *
 * It lives in `repository/` from the start rather than inside a test file. In
 * Helios it had to be lifted out later, once the pipeline tests needed it too.
 *
 * **The CREATE TABLE below must match the generated migration column for
 * column.** If they drift, every test passes against a table that does not
 * exist in production. `do.repository.test.ts` asserts this directly by reading
 * the generated `.sql` off disk.
 */
export function createTestDb() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE atlas_runs (
			id TEXT PRIMARY KEY NOT NULL,
			pipeline_id TEXT NOT NULL,
			design_session_id TEXT NOT NULL,
			status TEXT NOT NULL,
			pattern_ref TEXT NOT NULL,
			garment_ref TEXT NOT NULL,
			garment_regions TEXT NOT NULL,
			image_r2_key TEXT,
			cost_usd REAL,
			model_metadata TEXT NOT NULL,
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
	);
}

/**
 * The harness typed as the client the repository takes.
 *
 * **This is the one cast in the test suite, and it lives here on purpose.**
 * Drizzle declares the sqlite-proxy driver `mode: "async"` and the
 * durable-sqlite driver `mode: "sync"`, so the two database types are not
 * assignable even though both are Drizzle over sqlite-core and both execute the
 * same SQL against a real database. Doing it once, here, means every call site
 * in every suite uses a fully-typed object with no cast of its own — so a test
 * that feeds a repository function the wrong shape fails to compile instead of
 * quietly passing.
 */
export function asDb(db: ReturnType<typeof createTestDb>): AtlasDb {
	return db as unknown as AtlasDb;
}

/** Inserts one row directly, bypassing the do.repository write helpers so each
 * test can set up exact created_at ordering and status combinations. */
export async function insertRow(
	db: ReturnType<typeof createTestDb>,
	overrides: Partial<typeof atlasRuns.$inferInsert> & { pipelineId: string },
) {
	await db.insert(atlasRuns).values({
		designSessionId: "design-1",
		status: "completed",
		patternRef: "iris/pattern.jpg",
		garmentRef: "https://example.com/shirt.jpg",
		garmentRegions: {},
		modelMetadata: {},
		...overrides,
	});
}
