import { beforeEach, describe, expect, it } from "vitest";
import type { HeliosParams } from "@aureline/shared-types";
import { heliosRuns } from "../db/schema";
import { completeImageRun, completeTextRun, getRunRows, getSettledRows, listRuns, pruneCompletedRuns } from "./do.repository";
import type { HeliosDb } from "../db/client";
import { createTestDb, insertRow } from "./test-db";

/** A complete, valid `HeliosParams`. Whole rather than a partial plus a cast,
 * so a contract change breaks this file instead of slipping past it. */
const PARAMS: HeliosParams = {
	motif_type: "art deco fan",
	repeat_type: "half-drop",
	scale: "medium",
	density: "balanced",
	line_weight: "medium",
	texture_technique: "hatching",
	contrast_level: "high",
	style: "traditional",
};

describe("pruneCompletedRuns", () => {
	let db: HeliosDb;

	beforeEach(() => {
		db = createTestDb();
	});

	it("keeps exactly the newest N completed runs and deletes whole runs, not rows", async () => {
		for (let i = 0; i < 5; i++) {
			const createdAt = new Date(1_000_000 + i * 1000);
			await insertRow(db, { pipelineId: `run-${i}`, modality: "text", createdAt });
			await insertRow(db, { pipelineId: `run-${i}`, modality: "image", createdAt: new Date(createdAt.getTime() + 10) });
		}

		const deleted = await pruneCompletedRuns(db, 2);

		expect(deleted).toBe(3);

		const remaining = await db.select().from(heliosRuns);
		const remainingRunIds = [...new Set(remaining.map((row) => row.pipelineId))].sort();
		expect(remainingRunIds).toEqual(["run-3", "run-4"]);
		expect(remaining).toHaveLength(4);
	});

	it("does nothing when completed runs are at or under the limit", async () => {
		await insertRow(db, { pipelineId: "run-0", modality: "text" });

		const deleted = await pruneCompletedRuns(db, 5);

		expect(deleted).toBe(0);
		expect(await db.select().from(heliosRuns)).toHaveLength(1);
	});

	it("survives a planner failure: one failed row, no image row, never pruned", async () => {
		for (let i = 0; i < 5; i++) {
			const createdAt = new Date(1_000_000 + i * 1000);
			await insertRow(db, { pipelineId: `run-${i}`, modality: "text", createdAt });
			await insertRow(db, { pipelineId: `run-${i}`, modality: "image", createdAt: new Date(createdAt.getTime() + 10) });
		}
		await insertRow(db, { pipelineId: "run-failed", modality: "text", status: "failed" });

		const deleted = await pruneCompletedRuns(db, 2);

		const remaining = await db.select().from(heliosRuns);
		const failedRows = remaining.filter((row) => row.pipelineId === "run-failed");
		expect(failedRows).toHaveLength(1);
		expect(failedRows[0]?.status).toBe("failed");
		expect(deleted).toBe(3);
	});

	it("leaves a run alone while one of its rows is still running", async () => {
		for (let i = 0; i < 5; i++) {
			const createdAt = new Date(1_000_000 + i * 1000);
			await insertRow(db, { pipelineId: `run-${i}`, modality: "text", createdAt });
			await insertRow(db, { pipelineId: `run-${i}`, modality: "image", createdAt: new Date(createdAt.getTime() + 10) });
		}
		// An older invocation mid-flight in the same DO. Oldest by created_at, so
		// a prune that ignored `running` would delete it first.
		const inFlightAt = new Date(500_000);
		await insertRow(db, { pipelineId: "run-in-flight", modality: "text", status: "completed", createdAt: inFlightAt });
		await insertRow(db, {
			pipelineId: "run-in-flight",
			modality: "image",
			status: "running",
			createdAt: new Date(inFlightAt.getTime() + 10),
		});

		const deleted = await pruneCompletedRuns(db, 2);

		expect(deleted).toBe(3);
		const remaining = await db.select().from(heliosRuns);
		expect(remaining.filter((row) => row.pipelineId === "run-in-flight")).toHaveLength(2);
	});

	it("survives an image failure: completed text row next to a failed image row, never pruned", async () => {
		for (let i = 0; i < 5; i++) {
			const createdAt = new Date(1_000_000 + i * 1000);
			await insertRow(db, { pipelineId: `run-${i}`, modality: "text", createdAt });
			await insertRow(db, { pipelineId: `run-${i}`, modality: "image", createdAt: new Date(createdAt.getTime() + 10) });
		}
		const failedCreatedAt = new Date(500_000);
		await insertRow(db, {
			pipelineId: "run-half-failed",
			modality: "text",
			status: "completed",
			createdAt: failedCreatedAt,
		});
		await insertRow(db, {
			pipelineId: "run-half-failed",
			modality: "image",
			status: "failed",
			createdAt: new Date(failedCreatedAt.getTime() + 10),
		});

		const deleted = await pruneCompletedRuns(db, 2);

		const remaining = await db.select().from(heliosRuns);
		const halfFailedRows = remaining.filter((row) => row.pipelineId === "run-half-failed");
		expect(halfFailedRows).toHaveLength(2);
		expect(deleted).toBe(3);
	});
});

describe("getRunRows", () => {
	it("returns only the rows for the requested invocation", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "run-a", modality: "text" });
		await insertRow(db, { pipelineId: "run-a", modality: "image" });
		await insertRow(db, { pipelineId: "run-b", modality: "text" });

		const rows = await getRunRows(db, "run-a");

		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.pipelineId === "run-a")).toBe(true);
	});
});

describe("getSettledRows", () => {
	it("returns completed and failed rows across every invocation, but never running ones", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "run-a", modality: "text", status: "completed" });
		await insertRow(db, { pipelineId: "run-b", modality: "text", status: "failed" });
		await insertRow(db, { pipelineId: "run-c", modality: "text", status: "running" });

		const rows = await getSettledRows(db);

		expect(rows.map((row) => row.pipelineId).sort()).toEqual(["run-a", "run-b"]);
	});
});

describe("listRuns", () => {
	it("returns every row newest first, across every invocation", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "older", modality: "text", createdAt: new Date(1_000_000) });
		await insertRow(db, { pipelineId: "newest", modality: "text", createdAt: new Date(3_000_000) });
		await insertRow(db, { pipelineId: "middle", modality: "text", createdAt: new Date(2_000_000) });

		const rows = await listRuns(db);

		expect(rows.map((row) => row.pipelineId)).toEqual(["newest", "middle", "older"]);
	});

	it("includes running rows, unlike getSettledRows", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "run-a", modality: "text", status: "completed" });
		await insertRow(db, { pipelineId: "run-b", modality: "text", status: "failed" });
		await insertRow(db, { pipelineId: "run-c", modality: "text", status: "running" });

		const listed = await listRuns(db);
		const settled = await getSettledRows(db);

		// The whole reason this is not just getSettledRows: an invocation still in
		// flight has to be visible to whoever is watching the session.
		expect(listed.map((row) => row.pipelineId).sort()).toEqual(["run-a", "run-b", "run-c"]);
		expect(settled.map((row) => row.pipelineId).sort()).toEqual(["run-a", "run-b"]);
	});

	it("returns an empty array for a session that has never run anything", async () => {
		expect(await listRuns(createTestDb())).toEqual([]);
	});
});

describe("settling a row that is not there", () => {
	// A bare `UPDATE ... WHERE` against a missing row matches nothing and resolves
	// exactly as if it had worked. These two prove the difference is now audible
	// rather than silent (AGENTS.md §7).

	it("completeImageRun throws rather than reporting success for a spent image", async () => {
		const db = createTestDb();
		// A text row for the same run, so this is specifically "no *image* row"
		// and not "no rows at all" — the latter would pass against a weaker guard.
		await insertRow(db, { pipelineId: "run-a", modality: "text" });

		await expect(
			completeImageRun(db, { pipelineId: "run-a", imageR2Key: "patterns/run-a.jpg", costUsd: 0.0009 }),
		).rejects.toThrow(/no image row to settle for pipeline_id run-a/);
	});

	it("completeTextRun throws rather than letting a pipeline report success with no rows", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "run-a", modality: "image" });

		await expect(
			completeTextRun(db, "run-a", PARAMS, { model: "a-model" }, 0.001),
		).rejects.toThrow(/no text row to settle for pipeline_id run-a/);
	});

	it("still settles normally when the row is there", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "run-a", modality: "image", status: "running" });

		await completeImageRun(db, { pipelineId: "run-a", imageR2Key: "patterns/run-a.jpg", costUsd: 0.0009 });

		const [row] = await getRunRows(db, "run-a");
		expect(row.status).toBe("completed");
		expect(row.imageR2Key).toBe("patterns/run-a.jpg");
	});
});
