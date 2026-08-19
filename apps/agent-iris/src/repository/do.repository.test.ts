import { beforeEach, describe, expect, it } from "vitest";
import { irisRuns } from "../db/schema";
import {
	completeImageRun,
	countResumeAttempts,
	failRunningRuns,
	getRunRows,
	getSettledRows,
	listRuns,
	pruneCompletedRuns,
	startImageRun,
} from "./do.repository";
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

		const remaining = await db.select().from(irisRuns);
		const remainingRunIds = [...new Set(remaining.map((row) => row.pInvocId))].sort();
		expect(remainingRunIds).toEqual(["run-3", "run-4"]);
		expect(remaining).toHaveLength(4);
	});

	it("does nothing when completed runs are at or under the limit", async () => {
		await insertRow(db, { pInvocId: "run-0", modality: "text" });

		const deleted = await pruneCompletedRuns(db as never, 5);

		expect(deleted).toBe(0);
		expect(await db.select().from(irisRuns)).toHaveLength(1);
	});

	it("survives a planner failure: one failed row, no image row, never pruned", async () => {
		for (let i = 0; i < 5; i++) {
			const createdAt = new Date(1_000_000 + i * 1000);
			await insertRow(db, { pInvocId: `run-${i}`, modality: "text", createdAt });
			await insertRow(db, { pInvocId: `run-${i}`, modality: "image", createdAt: new Date(createdAt.getTime() + 10) });
		}
		await insertRow(db, { pInvocId: "run-failed", modality: "text", status: "failed" });

		const deleted = await pruneCompletedRuns(db as never, 2);

		const remaining = await db.select().from(irisRuns);
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
		const remaining = await db.select().from(irisRuns);
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

		const remaining = await db.select().from(irisRuns);
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

describe("listRuns", () => {
	it("returns every row newest first, across every invocation", async () => {
		const db = createTestDb();
		await insertRow(db, { pInvocId: "older", modality: "text", createdAt: new Date(1_000_000) });
		await insertRow(db, { pInvocId: "newest", modality: "text", createdAt: new Date(3_000_000) });
		await insertRow(db, { pInvocId: "middle", modality: "text", createdAt: new Date(2_000_000) });

		const rows = await listRuns(db as never);

		expect(rows.map((row) => row.pInvocId)).toEqual(["newest", "middle", "older"]);
	});

	it("includes running rows, unlike getSettledRows", async () => {
		const db = createTestDb();
		await insertRow(db, { pInvocId: "run-a", modality: "text", status: "completed" });
		await insertRow(db, { pInvocId: "run-b", modality: "text", status: "failed" });
		await insertRow(db, { pInvocId: "run-c", modality: "text", status: "running" });

		const listed = await listRuns(db as never);
		const settled = await getSettledRows(db as never);

		// The whole reason this is not just getSettledRows: an invocation still in
		// flight has to be visible to whoever is watching the session.
		expect(listed.map((row) => row.pInvocId).sort()).toEqual(["run-a", "run-b", "run-c"]);
		expect(settled.map((row) => row.pInvocId).sort()).toEqual(["run-a", "run-b"]);
	});

	it("returns an empty array for a session that has never run anything", async () => {
		expect(await listRuns(createTestDb() as never)).toEqual([]);
	});
});

describe("failRunningRuns", () => {
	it("marks the running row failed and writes through the cost already spent", async () => {
		const db = createTestDb();
		await insertRow(db, { pInvocId: "run-a", modality: "text", status: "completed", costUsd: 0.01 });
		await insertRow(db, { pInvocId: "run-a", modality: "image", status: "running" });

		await failRunningRuns(db as never, "run-a", 0.42);

		const rows = await getRunRows(db as never, "run-a");
		const imageRow = rows.find((row) => row.modality === "image");
		expect(imageRow?.status).toBe("failed");
		expect(imageRow?.costUsd).toBe(0.42);
		expect(imageRow?.completedAt).not.toBeNull();
	});

	it("leaves cost untouched when the caller has none to record", async () => {
		const db = createTestDb();
		await insertRow(db, { pInvocId: "run-a", modality: "text", status: "running", costUsd: null });

		await failRunningRuns(db as never, "run-a", null);

		const rows = await getRunRows(db as never, "run-a");
		expect(rows[0]?.status).toBe("failed");
		expect(rows[0]?.costUsd).toBeNull();
	});

	it("only touches rows still running for that invocation", async () => {
		const db = createTestDb();
		await insertRow(db, { pInvocId: "run-a", modality: "text", status: "completed" });
		await insertRow(db, { pInvocId: "run-b", modality: "text", status: "running" });

		await failRunningRuns(db as never, "run-a", 1);

		const runA = await getRunRows(db as never, "run-a");
		const runB = await getRunRows(db as never, "run-b");
		expect(runA[0]?.status).toBe("completed");
		expect(runB[0]?.status).toBe("running");
	});
});

describe("countResumeAttempts", () => {
	it("counts image rows by root in model_metadata", async () => {
		const db = createTestDb();
		await insertRow(db, { pInvocId: "run-a", modality: "image", modelMetadata: { root: "brief-1" } });
		await insertRow(db, { pInvocId: "run-b", modality: "image", modelMetadata: { root: "brief-1" } });
		await insertRow(db, { pInvocId: "run-c", modality: "image", modelMetadata: { root: "brief-2" } });
		await insertRow(db, { pInvocId: "run-d", modality: "image", modelMetadata: {} });

		expect(await countResumeAttempts(db as never, "brief-1")).toBe(2);
		expect(await countResumeAttempts(db as never, "brief-2")).toBe(1);
		expect(await countResumeAttempts(db as never, "brief-never-seen")).toBe(0);
	});
});

describe("startImageRun / completeImageRun", () => {
	it("duplicates motif_ref and planner_params onto the image row and settles it with its R2 key and cost", async () => {
		const db = createTestDb();

		await startImageRun(db as never, "run-a", "helios-run", "a pattern", "motif-key", { primary_color: "gold" } as never, {});
		await completeImageRun(db as never, "run-a", "r2/key.png", 0.05);

		const rows = await getRunRows(db as never, "run-a");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.motifRef).toBe("motif-key");
		expect(rows[0]?.status).toBe("completed");
		expect(rows[0]?.imageR2Key).toBe("r2/key.png");
		expect(rows[0]?.costUsd).toBe(0.05);
	});
});
