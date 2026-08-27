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
/**
 * The table both fakes create, written once.
 *
 * `schema.ts` is the source of truth and nothing enforces that this matches it
 * (AGENTS.md §8) — so there is exactly one copy to keep in step rather than one
 * per fake. A second copy would double the thing that can silently drift.
 */
const IRIS_RUNS_DDL = `
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
`;

export function createTestDb(): IrisDb {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(IRIS_RUNS_DDL);

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

/**
 * A `D1Database` that really writes, backed by the same in-memory SQLite and
 * the same DDL as `createTestDb`.
 *
 * **This exists because a fake that cannot write turns an export failure into a
 * passing test.** `exportAndPrune` swallows everything it catches, by design —
 * an audit concern must not cost a caller the result they already paid for. So
 * a `DB` binding of `{}` throws on the first `prepare`, the catch logs it, and
 * the suite stays green while nothing has been exported. The whole point of
 * this fake is that `getD1Db(env.DB)` returns a client whose rows can be read
 * back and asserted on.
 *
 * Only the surface `drizzle-orm/d1` actually reaches is implemented: `prepare`
 * returning a statement that `bind`s, and bound `run`/`all`/`raw`/`first`, plus
 * `batch`. `all` hands back objects and `raw` hands back values in select
 * order, which is the distinction the driver relies on.
 *
 * **The one cast in this function** is the return. A real `D1Database` is a
 * Workers runtime binding and cannot be constructed outside a Worker; asserting
 * it once here is what lets every call site be checked against the real type
 * instead of each one loosening itself (AGENTS.md §4), the same trade
 * `createTestDb` makes above.
 */
export function createTestD1(): D1Database {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(IRIS_RUNS_DDL);

	// One bound statement. `bind` returns a new one rather than mutating, which
	// is D1's own contract and is what lets the driver hold an unbound statement
	// and bind it more than once.
	const statement = (sql: string, params: readonly unknown[]) => {
		// The same narrowing `createTestDb` uses below: `node:sqlite` types its
		// bindings as its own union and the driver hands over `unknown[]`.
		const bound = params as Parameters<ReturnType<typeof sqlite.prepare>["all"]>;

		return {
			bind: (...next: unknown[]) => statement(sql, next),
			run: async () => {
				sqlite.prepare(sql).run(...bound);
				return { results: [], success: true, meta: {} };
			},
			all: async () => ({ results: sqlite.prepare(sql).all(...bound), success: true, meta: {} }),
			raw: async () => {
				const stmt = sqlite.prepare(sql);
				const names = stmt.columns().map((column) => column.name);
				return stmt.all(...bound).map((row) => names.map((name) => (row as Record<string, unknown>)[name]));
			},
			first: async () => sqlite.prepare(sql).all(...bound)[0] ?? null,
		};
	};

	return {
		prepare: (sql: string) => statement(sql, []),
		// Sequential rather than transactional. Nothing in this app calls `batch`,
		// but the driver's type requires it and a silent `[]` would make a future
		// caller's rows vanish without an error.
		batch: async (statements: { run: () => Promise<unknown> }[]) =>
			Promise.all(statements.map((one) => one.run())),
	} as unknown as D1Database;
}

/**
 * A `D1Database` that fails on first contact, for proving `exportAndPrune`
 * swallows an export failure rather than costing the caller their result.
 *
 * Built by replacing one method on a real one rather than by asserting a
 * second literal, so this file still holds exactly the two casts its comments
 * account for.
 */
export function createFailingD1(): D1Database {
	const d1 = createTestD1();

	// `Object.assign` rather than a spread: `D1Database`'s members are declared
	// as methods, and spreading the interface loses them, leaving a literal that
	// no longer satisfies the type. Mutating the real one keeps every other
	// method intact and needs no second assertion.
	return Object.assign(d1, {
		prepare: () => {
			throw new Error("d1 unavailable");
		},
	});
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
