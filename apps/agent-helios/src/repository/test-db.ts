import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { HeliosDb } from "../db/client";
import * as schema from "../db/schema";
import { heliosRuns } from "../db/schema";

/**
 * The table both fakes create, written once.
 *
 * `schema.ts` is the source of truth and nothing enforces that this matches it
 * (AGENTS.md §8) — so there is exactly one copy to keep in step rather than one
 * per fake. A second copy would double the thing that can silently drift.
 *
 * `created_at` is seconds, matching `schema.ts`'s `mode: "timestamp"` and the
 * generated migration. Iris's equivalent is milliseconds because its column is
 * `timestamp_ms`; the two engines differ here and copying Iris's default across
 * would make every Helios test read timestamps Drizzle then misreads by a
 * factor of a thousand.
 */
const HELIOS_RUNS_DDL = `
	CREATE TABLE helios_runs (
		id TEXT PRIMARY KEY,
		pipeline_id TEXT NOT NULL,
		design_session_id TEXT NOT NULL,
		modality TEXT NOT NULL,
		status TEXT NOT NULL,
		user_prompt TEXT NOT NULL,
		planner_params TEXT NOT NULL,
		image_r2_key TEXT,
		cost_usd REAL,
		model_metadata TEXT NOT NULL,
		created_at INTEGER NOT NULL DEFAULT (unixepoch()),
		completed_at INTEGER,
		-- Last, because ALTER TABLE ADD COLUMN appends, and that is where every
		-- migrated database has it. Backticks are deliberately absent: this DDL is
		-- a template literal and one would end the string. See db/schema.ts.
		classification TEXT NOT NULL DEFAULT '{}'
	);
`;

/**
 * A real in-memory SQLite database behind the same Drizzle schema the DO and
 * D1 both use. Both `HeliosDb` and `HeliosD1Db` are `drizzle-orm` instances
 * over sqlite-core, so this stands in for either without a Worker runtime.
 *
 * Node's own `node:sqlite` rather than a native module, driven through the
 * `sqlite-proxy` driver because Drizzle has no `node:sqlite` driver of its own.
 * That keeps a compiled dependency and its install script out of a project
 * whose runtime is Workers and never uses SQLite from Node at all. Requires
 * Node 24, which the root `engines` field declares.
 *
 * Lifted out of `do.repository.test.ts` so every suite that needs a database
 * shares one definition.
 *
 * **Returns `HeliosDb`, via one of the two casts in this file.** The proxy
 * driver is a `BaseSQLiteDatabase<"async", …>` and `HeliosDb` is a
 * `BaseSQLiteDatabase<"sync", …>`, so the two are not assignable even though
 * the query surface every suite uses is identical and every statement is
 * awaited either way. Asserting it here once is what lets every call site be
 * checked against the real `HeliosDb`.
 *
 * The alternative — `as never` at each call site — is what this replaces.
 *
 * One correction to the framing in AGENTS.md §4, checked rather than assumed:
 * `db as never` does **not** switch off checking of the other arguments in that
 * call. `never` is assignable to `HeliosDb`, so every other argument is still
 * checked, and a wrong-shaped params object next to it is still a compile error.
 * The escapes were per-argument, and the reason a bad params object could sit in
 * a green suite is that it carried a cast *of its own*.
 *
 * That makes this change less dramatic than advertised and no less worth doing:
 * 66 call sites were one careless `as never` away from hiding the next bad
 * argument, and the noise made the casts that were load-bearing impossible to
 * pick out.
 */
/**
 * The `prompts` table, created by `createTestD1` and deliberately NOT by
 * `createTestDb`.
 *
 * It lives in `db/schema.d1.ts`, which only the D1 drizzle config reads, so it
 * exists in D1 and never in the Durable Object's own SQLite. A fake DO that
 * created it would let a test pass against a table production does not have
 * there.
 *
 * Mirrors `schema.d1.ts` by hand, and nothing enforces the match (AGENTS.md
 * §8) — change the schema and change this in the same edit. `updated_at` keeps
 * the `DEFAULT CURRENT_TIMESTAMP` specifically so a test can prove the default
 * fires on INSERT and does *not* fire on UPDATE, which is why `upsertPrompt`
 * sets the column itself.
 */
const PROMPTS_DDL = `
	CREATE TABLE prompts (
		id INTEGER PRIMARY KEY,
		slot TEXT NOT NULL UNIQUE,
		prompt_text TEXT NOT NULL,
		updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	);
`;

export function createTestDb(): HeliosDb {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(HELIOS_RUNS_DDL);

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
	) as unknown as HeliosDb;
}

/**
 * A `D1Database` that really writes, backed by the same in-memory SQLite and
 * the same DDL as `createTestDb`.
 *
 * **This exists because a fake that cannot write turns an export failure into a
 * passing test.** `exportAndPrune` swallows everything it catches, by design —
 * an audit concern must not cost a caller the result they already paid for. So
 * the old no-op fake answered every query with nothing, the export appeared to
 * succeed, and the suite stayed green while nothing had been written. The whole
 * point of this fake is that `getD1Db(env.DB)` returns a client whose rows can
 * be read back and asserted on.
 *
 * Only the surface `drizzle-orm/d1` actually reaches is implemented: `prepare`
 * returning a statement that `bind`s, and bound `run`/`all`/`raw`/`first`, plus
 * `batch`. `all` hands back objects and `raw` hands back values in select order,
 * which is the distinction the driver relies on — and `raw` is the one a
 * `select()` actually goes through, so a fake that stubs only `all` looks like it
 * works and quietly returns nothing.
 *
 * **The one cast in this function** is the return. A real `D1Database` is a
 * Workers runtime binding and cannot be constructed outside a Worker; asserting
 * it once here is what lets every call site be checked against the real type
 * instead of each one loosening itself (AGENTS.md §4), the same trade
 * `createTestDb` makes above.
 */
export function createTestD1(): D1Database {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(HELIOS_RUNS_DDL);
	sqlite.exec(PROMPTS_DDL);

	// One bound statement. `bind` returns a new one rather than mutating, which
	// is D1's own contract and is what lets the driver hold an unbound statement
	// and bind it more than once.
	const statement = (sql: string, params: readonly unknown[]) => {
		// The same narrowing `createTestDb` uses above: `node:sqlite` types its
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
		batch: async (statements: { run: () => Promise<unknown> }[]) => Promise.all(statements.map((one) => one.run())),
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
	db: HeliosDb,
	overrides: Partial<typeof heliosRuns.$inferInsert> & { pipelineId: string; modality: "text" | "image" },
) {
	await db.insert(heliosRuns).values({
		designSessionId: "design-1",
		status: "completed",
		userPrompt: "a pattern",
		plannerParams: {},
		modelMetadata: {},
		...overrides,
	});
}
