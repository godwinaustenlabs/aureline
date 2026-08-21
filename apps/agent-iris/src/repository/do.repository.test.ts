import { beforeEach, describe, expect, it } from "vitest";
import { irisRuns } from "../db/schema";
import {
	completeImageRun,
	completeTextRun,
	countResumeAttempts,
	failRunningRuns,
	getRunRows,
	getSettledRows,
	insertFailedImageRun,
	insertResumedTextRun,
	listRuns,
	pruneCompletedRuns,
	startImageRun,
	startTextRun,
} from "./do.repository";
import { createTestDb, insertRow } from "./test-db";
import { sampleParamsFull } from "../fixtures/sample-params";

describe("pruneCompletedRuns", () => {
	let db: ReturnType<typeof createTestDb>;

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

		const remaining = await db.select().from(irisRuns);
		const remainingRunIds = [...new Set(remaining.map((row) => row.pipelineId))].sort();
		expect(remainingRunIds).toEqual(["run-3", "run-4"]);
		expect(remaining).toHaveLength(4);
	});

	it("does nothing when completed runs are at or under the limit", async () => {
		await insertRow(db, { pipelineId: "run-0", modality: "text" });

		const deleted = await pruneCompletedRuns(db, 5);

		expect(deleted).toBe(0);
		expect(await db.select().from(irisRuns)).toHaveLength(1);
	});

	it("survives a planner failure: one failed row, no image row, never pruned", async () => {
		for (let i = 0; i < 5; i++) {
			const createdAt = new Date(1_000_000 + i * 1000);
			await insertRow(db, { pipelineId: `run-${i}`, modality: "text", createdAt });
			await insertRow(db, { pipelineId: `run-${i}`, modality: "image", createdAt: new Date(createdAt.getTime() + 10) });
		}
		await insertRow(db, { pipelineId: "run-failed", modality: "text", status: "failed" });

		const deleted = await pruneCompletedRuns(db, 2);

		const remaining = await db.select().from(irisRuns);
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
		const remaining = await db.select().from(irisRuns);
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

		const remaining = await db.select().from(irisRuns);
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

describe("failRunningRuns", () => {
	it("marks the running row failed and writes through the cost already spent", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "run-a", modality: "text", status: "completed", costUsd: 0.01 });
		await insertRow(db, { pipelineId: "run-a", modality: "image", status: "running" });

		await failRunningRuns(db, "run-a", 0.42);

		const rows = await getRunRows(db, "run-a");
		const imageRow = rows.find((row) => row.modality === "image");
		expect(imageRow?.status).toBe("failed");
		expect(imageRow?.costUsd).toBe(0.42);
		expect(imageRow?.completedAt).not.toBeNull();
	});

	it("leaves cost untouched when the caller has none to record", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "run-a", modality: "text", status: "running", costUsd: null });

		await failRunningRuns(db, "run-a", null);

		const rows = await getRunRows(db, "run-a");
		expect(rows[0]?.status).toBe("failed");
		expect(rows[0]?.costUsd).toBeNull();
	});

	it("only touches rows still running for that invocation", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "run-a", modality: "text", status: "completed" });
		await insertRow(db, { pipelineId: "run-b", modality: "text", status: "running" });

		await failRunningRuns(db, "run-a", 1);

		const runA = await getRunRows(db, "run-a");
		const runB = await getRunRows(db, "run-b");
		expect(runA[0]?.status).toBe("completed");
		expect(runB[0]?.status).toBe("running");
	});
});

describe("countResumeAttempts", () => {
	it("counts image rows by root in model_metadata", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "run-a", modality: "image", modelMetadata: { root: "brief-1" } });
		await insertRow(db, { pipelineId: "run-b", modality: "image", modelMetadata: { root: "brief-1" } });
		await insertRow(db, { pipelineId: "run-c", modality: "image", modelMetadata: { root: "brief-2" } });
		await insertRow(db, { pipelineId: "run-d", modality: "image", modelMetadata: {} });

		expect(await countResumeAttempts(db, "brief-1")).toBe(2);
		expect(await countResumeAttempts(db, "brief-2")).toBe(1);
		expect(await countResumeAttempts(db, "brief-never-seen")).toBe(0);
	});
});

describe("startImageRun / completeImageRun", () => {
	it("duplicates motif_ref and planner_params onto the image row and settles it with its R2 key and cost", async () => {
		const db = createTestDb();

		await startImageRun(db, {
			pipelineId: "run-a",
			designSessionId: "design-1",
			userPrompt: "a pattern",
			motifRef: "motif-key",
			plannerParams: sampleParamsFull,
			modelMetadata: {},
		});
		await completeImageRun(db, { pipelineId: "run-a", imageR2Key: "r2/key.png", costUsd: 0.05 });

		const rows = await getRunRows(db, "run-a");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.motifRef).toBe("motif-key");
		expect(rows[0]?.status).toBe("completed");
		expect(rows[0]?.imageR2Key).toBe("r2/key.png");
		expect(rows[0]?.costUsd).toBe(0.05);
	});

	it("merges new metadata over what startImageRun wrote instead of replacing it", async () => {
		const db = createTestDb();

		await startImageRun(db, {
			pipelineId: "run-a",
			designSessionId: "design-1",
			userPrompt: "a pattern",
			motifRef: "motif-key",
			plannerParams: sampleParamsFull,
			modelMetadata: { model: "flux" },
		});
		await completeImageRun(db, {
			pipelineId: "run-a",
			imageR2Key: "r2/key.png",
			costUsd: 0.05,
			modelMetadata: { width: 128, height: 128 },
		});

		const rows = await getRunRows(db, "run-a");
		// The model name survives alongside the dimensions added afterwards. It is
		// the only record of which model was actually called.
		expect(rows[0]?.modelMetadata).toEqual({ model: "flux", width: 128, height: 128 });
	});

	it("throws rather than silently doing nothing when there is no image row to settle", async () => {
		const db = createTestDb();
		// A text row for the same run, so this is specifically "no *image* row"
		// rather than "no rows at all".
		await insertRow(db, { pipelineId: "run-a", modality: "text" });

		// The caller has already paid for an image by this point. Reporting success
		// while recording nothing is how a spent run comes to look like it never
		// happened (AGENTS.md §7).
		await expect(completeImageRun(db, { pipelineId: "run-a", imageR2Key: "r2/key.png", costUsd: 0.05 })).rejects.toThrow(
			/no image row to settle/,
		);
	});
});

describe("startTextRun / completeTextRun", () => {
	it("opens the text row running with empty params, then settles it with the planner's", async () => {
		const db = createTestDb();

		await startTextRun(db, {
			pipelineId: "run-a",
			designSessionId: "design-1",
			userPrompt: "art deco paisley",
			motifRef: "motif-key",
			modelMetadata: { model: "gpt-oss" },
		});

		const opened = await getRunRows(db, "run-a");
		expect(opened).toHaveLength(1);
		expect(opened[0]?.status).toBe("running");
		expect(opened[0]?.modality).toBe("text");
		// Opens empty on purpose: the planner has not run yet, and a row claiming
		// params it does not have is worse than one claiming none.
		expect(opened[0]?.plannerParams).toEqual({});
		expect(opened[0]?.completedAt).toBeNull();

		await completeTextRun(db, "run-a", sampleParamsFull, { model: "gpt-oss", tokens: 120 }, 0.002);

		const settled = await getRunRows(db, "run-a");
		expect(settled[0]?.status).toBe("completed");
		expect(settled[0]?.plannerParams).toEqual(sampleParamsFull);
		expect(settled[0]?.costUsd).toBe(0.002);
		expect(settled[0]?.completedAt).not.toBeNull();
	});

	it("settles only the text row, leaving a sibling image row alone", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "run-a", modality: "text", status: "running" });
		await insertRow(db, { pipelineId: "run-a", modality: "image", status: "running" });

		await completeTextRun(db, "run-a", sampleParamsFull, {}, null);

		const rows = await getRunRows(db, "run-a");
		expect(rows.find((row) => row.modality === "text")?.status).toBe("completed");
		expect(rows.find((row) => row.modality === "image")?.status).toBe("running");
	});
});

describe("insertResumedTextRun", () => {
	it("inserts an already-settled text row carrying the original params and no cost", async () => {
		const db = createTestDb();

		await insertResumedTextRun(db, {
			pipelineId: "resumed-run",
			designSessionId: "design-1",
			userPrompt: "art deco paisley",
			motifRef: "motif-key",
			plannerParams: sampleParamsFull,
			modelMetadata: { root: "original-run" },
		});

		const rows = await getRunRows(db, "resumed-run");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("completed");
		expect(rows[0]?.completedAt).not.toBeNull();
		expect(rows[0]?.plannerParams).toEqual(sampleParamsFull);
		// Null on purpose: copying the original planner's cost here would bill the
		// same planner call twice across every cost report.
		expect(rows[0]?.costUsd).toBeNull();
	});
});

describe("insertFailedImageRun", () => {
	it("records an already-failed image row so the invocation is still two rows", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "run-a", modality: "text", status: "failed" });

		await insertFailedImageRun(db, {
			pipelineId: "run-a",
			designSessionId: "design-1",
			userPrompt: "art deco paisley",
			motifRef: "motif-key",
			plannerParams: sampleParamsFull,
			modelMetadata: {},
		});

		const rows = await getRunRows(db, "run-a");
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.modality === "image")?.status).toBe("failed");
		expect(rows.find((row) => row.modality === "image")?.completedAt).not.toBeNull();
	});

	it("accepts empty params, for a run that failed before the planner produced any", async () => {
		const db = createTestDb();

		await insertFailedImageRun(db, {
			pipelineId: "run-a",
			designSessionId: "design-1",
			userPrompt: "art deco paisley",
			motifRef: "motif-key",
			plannerParams: {},
			modelMetadata: {},
		});

		const rows = await getRunRows(db, "run-a");
		expect(rows[0]?.plannerParams).toEqual({});
		expect(rows[0]?.status).toBe("failed");
	});

	it("survives the prune, because a failed run is never deleted", async () => {
		const db = createTestDb();
		for (let i = 0; i < 5; i++) {
			await insertRow(db, { pipelineId: `run-${i}`, modality: "text", createdAt: new Date(1_000_000 + i * 1000) });
			await insertRow(db, { pipelineId: `run-${i}`, modality: "image", createdAt: new Date(1_000_010 + i * 1000) });
		}
		await insertRow(db, { pipelineId: "run-failed", modality: "text", status: "failed" });
		await insertFailedImageRun(db, {
			pipelineId: "run-failed",
			designSessionId: "design-1",
			userPrompt: "art deco paisley",
			motifRef: "motif-key",
			plannerParams: {},
			modelMetadata: {},
		});

		await pruneCompletedRuns(db, 2);

		// The whole reason insertFailedImageRun exists: without its row, this run
		// would be a lone completed-looking text row and the prune would take it.
		expect(await getRunRows(db, "run-failed")).toHaveLength(2);
	});
});

describe("timestamps", () => {
	it("stores created_at as milliseconds, so a defaulted row reads back as now and not 1970", async () => {
		const db = createTestDb();
		const before = Date.now();

		// No createdAt supplied, so the column default is what writes it. That
		// default is the thing under test: everything else in this suite passes an
		// explicit Date and would pass whatever units the column used.
		await insertRow(db, { pipelineId: "run-a", modality: "text" });

		const [row] = await getRunRows(db, "run-a");
		const storedAt = row?.createdAt.getTime() ?? 0;

		// A seconds column read through mode: "timestamp_ms" lands in January 1970,
		// which is why the year is worth asserting on its own — the range check
		// below would catch it too, but this says what went wrong.
		expect(row?.createdAt.getUTCFullYear()).toBe(new Date().getUTCFullYear());
		// One second of slack either side: the default is evaluated by SQLite
		// between these two readings, not by the test.
		expect(storedAt).toBeGreaterThanOrEqual(before - 1000);
		expect(storedAt).toBeLessThanOrEqual(Date.now() + 1000);
	});

	it("round-trips a completed_at written from JS at millisecond precision", async () => {
		const db = createTestDb();
		// A time with a non-zero millisecond component, so truncation to seconds
		// is visible rather than lucky.
		const settledAt = new Date("2026-08-20T12:34:56.789Z");

		await insertRow(db, { pipelineId: "run-a", modality: "image", completedAt: settledAt });

		const [row] = await getRunRows(db, "run-a");
		expect(row?.completedAt?.toISOString()).toBe("2026-08-20T12:34:56.789Z");
	});
});
