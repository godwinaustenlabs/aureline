import { beforeEach, describe, expect, it } from "vitest";
import { heliosRuns } from "../db/schema";
import { getRunRows, getSettledRows, pruneCompletedRuns } from "./do.repository";
import { exportRuns, readRun } from "./d1.repository";
import { createTestDb, insertRow } from "./test-db";

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

	it("leaves a run alone while one of its rows is still running", async () => {
		for (let i = 0; i < 5; i++) {
			const createdAt = new Date(1_000_000 + i * 1000);
			await insertRow(db, { pInvocId: `run-${i}`, modality: "text", createdAt });
			await insertRow(db, { pInvocId: `run-${i}`, modality: "image", createdAt: new Date(createdAt.getTime() + 10) });
		}
		// An older invocation mid-flight in the same DO. Oldest by created_at, so
		// a prune that ignored `running` would delete it first.
		const inFlightAt = new Date(500_000);
		await insertRow(db, { pInvocId: "run-in-flight", modality: "text", status: "completed", createdAt: inFlightAt });
		await insertRow(db, {
			pInvocId: "run-in-flight",
			modality: "image",
			status: "running",
			createdAt: new Date(inFlightAt.getTime() + 10),
		});

		const deleted = await pruneCompletedRuns(db as never, 2);

		expect(deleted).toBe(3);
		const remaining = await db.select().from(heliosRuns);
		expect(remaining.filter((row) => row.pInvocId === "run-in-flight")).toHaveLength(2);
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

describe("getSettledRows", () => {
	it("returns completed and failed rows across every invocation, but never running ones", async () => {
		const db = createTestDb();
		await insertRow(db, { pInvocId: "run-a", modality: "text", status: "completed" });
		await insertRow(db, { pInvocId: "run-b", modality: "text", status: "failed" });
		await insertRow(db, { pInvocId: "run-c", modality: "text", status: "running" });

		const rows = await getSettledRows(db as never);

		expect(rows.map((row) => row.pInvocId).sort()).toEqual(["run-a", "run-b"]);
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

	it("exports nothing, without erroring, when there is nothing settled", async () => {
		const d1Db = createTestDb();

		await exportRuns(d1Db as never, []);

		expect(await d1Db.select().from(heliosRuns)).toHaveLength(0);
	});

	/**
	 * D1 caps a query at 100 bound parameters and `helios_runs` binds 11 per row,
	 * so `exportRuns` chunks at nine. 25 rows crosses that boundary twice and
	 * ends mid-chunk, which is where an off-by-one in the slice would show up.
	 */
	it("exports every row when there are more than one insert can carry", async () => {
		const doDb = createTestDb();
		const d1Db = createTestDb();
		for (let i = 0; i < 25; i++) {
			await insertRow(doDb, { pInvocId: `run-${i}`, modality: "text" });
		}

		await exportRuns(d1Db as never, await getSettledRows(doDb as never));

		expect(await d1Db.select().from(heliosRuns)).toHaveLength(25);
	});
});

describe("readRun", () => {
	it("reads back exactly what was exported, through code rather than a hand-typed query", async () => {
		const doDb = createTestDb();
		const d1Db = createTestDb();
		await insertRow(doDb, { pInvocId: "run-a", modality: "text", status: "completed" });
		await insertRow(doDb, { pInvocId: "run-a", modality: "image", status: "failed" });
		await insertRow(doDb, { pInvocId: "run-b", modality: "text", status: "completed" });

		await exportRuns(d1Db as never, await getSettledRows(doDb as never));

		const readBack = await readRun(d1Db as never, "run-a");

		expect(readBack).toHaveLength(2);
		expect(readBack.every((row) => row.pInvocId === "run-a")).toBe(true);
		expect(readBack.map((row) => row.status).sort()).toEqual(["completed", "failed"]);
		expect(readBack.map((row) => row.modality).sort()).toEqual(["image", "text"]);
	});

	it("returns an empty array for a run that was never exported", async () => {
		const d1Db = createTestDb();

		expect(await readRun(d1Db as never, "never-happened")).toEqual([]);
	});
});