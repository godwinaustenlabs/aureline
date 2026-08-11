import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { heliosRuns } from "../db/schema";
import { getRunRows, pruneCompletedRuns } from "./do.repository";
import { exportRuns } from "./d1.repository";

/**
 * A real in-memory SQLite database behind the same Drizzle schema the DO and
 * D1 both use. Both `HeliosDb` and `HeliosD1Db` are `drizzle-orm` instances
 * over sqlite-core, so this stands in for either without a Worker runtime.
 */
function createTestDb() {
	const sqlite = new Database(":memory:");
	sqlite.exec(`
		CREATE TABLE helios_runs (
			id TEXT PRIMARY KEY,
			p_invoc_id TEXT NOT NULL,
			modality TEXT NOT NULL,
			status TEXT NOT NULL,
			user_prompt TEXT NOT NULL,
			planner_params TEXT NOT NULL,
			image_r2_key TEXT,
			cost_usd REAL,
			model_metadata TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			completed_at INTEGER
		);
	`);
	return drizzle(sqlite, { schema });
}

/** Inserts one row directly, bypassing the do.repository write helpers so
 * each test can set up exact created_at ordering and status combinations. */
async function insertRow(
	db: ReturnType<typeof createTestDb>,
	overrides: Partial<typeof heliosRuns.$inferInsert> & { pInvocId: string; modality: "text" | "image" },
) {
	await db.insert(heliosRuns).values({
		status: "completed",
		userPrompt: "a pattern",
		plannerParams: {},
		modelMetadata: {},
		...overrides,
	});
}

describe("pruneCompletedRuns", () => {
	let db: ReturnType<typeof createTestDb>;

	beforeEach(() => {
		db = createTestDb();
	});

	it("keeps exactly the newest N completed runs and deletes whole runs, not rows", async () => {
		for (let i = 0; i < 5; i++) {
			const createdAt = new Date(1_000_000 + i * 1000);
			await insertRow(db, { pInvocId: `run-${i}`, modality: "text", createdAt });
			await insertRow(db, { pInvocId: `run-${i}`, modality: "image", createdAt: new Date(createdAt.getTime() + 10) });
		}

		const deleted = await pruneCompletedRuns(db as never, 2);

		expect(deleted).toBe(3);

		const remaining = await db.select().from(heliosRuns);
		const remainingRunIds = [...new Set(remaining.map((row) => row.pInvocId))].sort();
		expect(remainingRunIds).toEqual(["run-3", "run-4"]);
		expect(remaining).toHaveLength(4);
	});

	it("does nothing when completed runs are at or under the limit", async () => {
		await insertRow(db, { pInvocId: "run-0", modality: "text" });

		const deleted = await pruneCompletedRuns(db as never, 5);

		expect(deleted).toBe(0);
		expect(await db.select().from(heliosRuns)).toHaveLength(1);
	});

	it("survives a planner failure: one failed row, no image row, never pruned", async () => {
		for (let i = 0; i < 5; i++) {
			const createdAt = new Date(1_000_000 + i * 1000);
			await insertRow(db, { pInvocId: `run-${i}`, modality: "text", createdAt });
			await insertRow(db, { pInvocId: `run-${i}`, modality: "image", createdAt: new Date(createdAt.getTime() + 10) });
		}
		await insertRow(db, { pInvocId: "run-failed", modality: "text", status: "failed" });

		const deleted = await pruneCompletedRuns(db as never, 2);

		const remaining = await db.select().from(heliosRuns);
		const failedRows = remaining.filter((row) => row.pInvocId === "run-failed");
		expect(failedRows).toHaveLength(1);
		expect(failedRows[0]?.status).toBe("failed");
		expect(deleted).toBe(3);
	});

	it("survives an image failure: completed text row next to a failed image row, never pruned", async () => {
		for (let i = 0; i < 5; i++) {
			const createdAt = new Date(1_000_000 + i * 1000);
			await insertRow(db, { pInvocId: `run-${i}`, modality: "text", createdAt });
			await insertRow(db, { pInvocId: `run-${i}`, modality: "image", createdAt: new Date(createdAt.getTime() + 10) });
		}
		const failedCreatedAt = new Date(500_000);
		await insertRow(db, {
			pInvocId: "run-half-failed",
			modality: "text",
			status: "completed",
			createdAt: failedCreatedAt,
		});
		await insertRow(db, {
			pInvocId: "run-half-failed",
			modality: "image",
			status: "failed",
			createdAt: new Date(failedCreatedAt.getTime() + 10),
		});

		const deleted = await pruneCompletedRuns(db as never, 2);

		const remaining = await db.select().from(heliosRuns);
		const halfFailedRows = remaining.filter((row) => row.pInvocId === "run-half-failed");
		expect(halfFailedRows).toHaveLength(2);
		expect(deleted).toBe(3);
	});
});

describe("getRunRows", () => {
	it("returns only the rows for the requested invocation", async () => {
		const db = createTestDb();
		await insertRow(db, { pInvocId: "run-a", modality: "text" });
		await insertRow(db, { pInvocId: "run-a", modality: "image" });
		await insertRow(db, { pInvocId: "run-b", modality: "text" });

		const rows = await getRunRows(db as never, "run-a");

		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.pInvocId === "run-a")).toBe(true);
	});
});

describe("exportRuns (idempotency)", () => {
	it("calling exportRuns twice with the same rows inserts once", async () => {
		const doDb = createTestDb();
		const d1Db = createTestDb();
		await insertRow(doDb, { pInvocId: "run-a", modality: "text" });
		await insertRow(doDb, { pInvocId: "run-a", modality: "image" });

		const rows = await getRunRows(doDb as never, "run-a");

		await exportRuns(d1Db as never, rows);
		await exportRuns(d1Db as never, rows);

		const exported = await d1Db.select().from(heliosRuns);
		expect(exported).toHaveLength(2);
	});
});