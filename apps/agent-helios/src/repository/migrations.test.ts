import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Runs the real migrations, in order, against a database that already holds a
 * row.
 *
 * **Nothing else in this repo executes a migration.** `repository/test-db.ts`
 * builds `helios_runs` with hand-written `CREATE TABLE`, which is the right
 * shape for testing queries and the wrong one for testing schema changes: a
 * migration can be syntactically fine, apply cleanly to a fresh database, and
 * still fail against every deployed one.
 *
 * That is not hypothetical. Phase 2's `classification` column generated
 * `ALTER TABLE helios_runs ADD classification text NOT NULL` — accepted by
 * SQLite on an empty table, rejected with "Cannot add a NOT NULL column with
 * default value NULL" the moment the table has rows. The fix was `.default({})`
 * in `schema.ts`; this file is what would have caught it.
 *
 * The row inserted before the later migrations is the whole point. Drop it and
 * this suite goes green against a migration that cannot be applied to
 * production.
 */

const DO_MIGRATIONS = join(__dirname, "..", "..", "drizzle");
const D1_MIGRATIONS = join(__dirname, "..", "..", "..", "..", "infrastructure", "d1", "migrations", "helios");

/** Migration files in the order drizzle-kit numbers them. */
function migrationsIn(directory: string): string[] {
	return readdirSync(directory)
		.filter((name) => name.endsWith(".sql"))
		.sort();
}

/** Drizzle separates statements with a marker `node:sqlite` does not know. */
function statementsOf(directory: string, file: string): string[] {
	return readFileSync(join(directory, file), "utf8")
		.split("--> statement-breakpoint")
		.map((statement) => statement.trim())
		.filter((statement) => statement !== "");
}

/** A complete row, so a migration is applied to a table that is not empty. */
const SEED_ROW = `
	INSERT INTO helios_runs
		(id, pipeline_id, design_session_id, modality, status, user_prompt, planner_params, model_metadata)
	VALUES
		('row-1', 'pipeline-1', 'design-1', 'text', 'completed', 'an art deco paisley', '{}', '{}');
`;

function applyAll(directory: string): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	const files = migrationsIn(directory);

	// The first migration creates the tables, so the row goes in after it and
	// before every subsequent one.
	for (const [index, file] of files.entries()) {
		for (const statement of statementsOf(directory, file)) {
			db.exec(statement);
		}
		if (index === 0) db.exec(SEED_ROW);
	}

	return db;
}

describe.each([
	["the Durable Object migrations", DO_MIGRATIONS],
	["the D1 migrations", D1_MIGRATIONS],
])("%s", (_label, directory) => {
	it("apply in order to a database that already holds a row", () => {
		// The assertion is that this does not throw. A migration that cannot be
		// applied to a populated table fails here rather than on a deploy.
		expect(() => applyAll(directory)).not.toThrow();
	});

	it("leave the existing row intact and backfilled", () => {
		const db = applyAll(directory);

		const rows = db.prepare("SELECT id, user_prompt, classification FROM helios_runs").all();

		expect(rows).toEqual([
			// `{}` rather than null: a run that predates the classifier was never
			// classified, which is a different statement from "unknown".
			{ id: "row-1", user_prompt: "an art deco paisley", classification: "{}" },
		]);
	});

	it("produce a table whose columns match schema.ts", () => {
		// The hand-written DDL in test-db.ts mirrors schema.ts and nothing enforces
		// the match; this checks the *migrations* against the same list, so a
		// column added to the schema without a migration is caught here.
		const db = applyAll(directory);

		const columns = db
			.prepare("SELECT name FROM pragma_table_info('helios_runs')")
			.all()
			.map((column) => (column as { name: string }).name);

		expect(columns).toEqual([
			"id",
			"pipeline_id",
			"design_session_id",
			"modality",
			"status",
			"user_prompt",
			"planner_params",
			"image_r2_key",
			"cost_usd",
			"model_metadata",
			"created_at",
			"completed_at",
			// Last because `ALTER TABLE … ADD COLUMN` appends. This assertion is the
			// reason `schema.ts` and `test-db.ts` declare it last too: the first
			// draft put it beside `planner_params`, which read better and described
			// a table no database anywhere actually has.
			"classification",
		]);
	});
});
