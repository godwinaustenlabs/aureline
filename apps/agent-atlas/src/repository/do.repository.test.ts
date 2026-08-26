import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AtlasPlacement } from "@aureline/shared-types";
import { createTestDb, insertRow } from "./test-db";
import {
	startRun,
	completeRun,
	insertFailedRun,
	failRunningRuns,
	countResumeAttempts,
	getRun,
	listRuns,
	getSettledRows,
	pruneCompletedRuns,
} from "./do.repository";
import type { AtlasDb } from "../db/client";

const PLACEMENT: AtlasPlacement = {
	garment_type: "tshirt",
	regions: ["back", "hem"],
	coverage: "allover",
	pattern_scale: "medium",
	prompt_version: "atlas-placement-v1",
};

/** `createTestDb` returns a sqlite-proxy instance; the repository takes the DO
 * client. Both are Drizzle over sqlite-core, which is the whole point of the
 * harness — this cast is what lets one database stand in for both. */
const asDb = (db: ReturnType<typeof createTestDb>) => db as unknown as AtlasDb;

/** The column names declared inside a `CREATE TABLE atlas_runs (...)`, in
 * order. Works on both the generated migration (backticked) and the harness's
 * hand-written statement (bare). */
function columnsOf(source: string): string[] {
	// Anchored on the table name and the opening paren, not on the words
	// "CREATE TABLE" alone — test-db.ts mentions those in its doc comment, and
	// anchoring there silently produced an empty column list.
	const open = source.search(/CREATE TABLE `?atlas_runs`? \(/);
	if (open === -1) throw new Error("no CREATE TABLE atlas_runs found");
	const body = source.slice(open, source.indexOf(");", open));
	// [a-z0-9_] and not [a-z_] — `image_r2_key` carries a digit, and a name
	// class that quietly drops it makes this whole guard pass while comparing
	// eleven columns to eleven.
	return [...body.matchAll(/^\s*`?([a-z0-9_]+)`?\s+(?:TEXT|INTEGER|REAL|text|integer|real)\b/gm)].map((m) => m[1]!);
}

describe("the test harness matches production", () => {
	it("has the same columns as the generated migration", () => {
		const dir = join(__dirname, "..", "..", "drizzle");
		const file = readdirSync(dir).find((name) => name.endsWith(".sql"));
		const generated = columnsOf(readFileSync(join(dir, file!), "utf8"));
		const declared = columnsOf(readFileSync(join(__dirname, "test-db.ts"), "utf8"));

		// If these drift, every test in this file passes against a table that
		// does not exist in production.
		expect(declared).toEqual(generated);
		// atlas-04: twelve, not Helios's eleven and not Iris's thirteen.
		expect(generated).toHaveLength(12);
		expect(generated).toContain("image_r2_key");
	});

	it("marks the five traceability columns NOT NULL in the migration", () => {
		const dir = join(__dirname, "..", "..", "drizzle");
		const file = readdirSync(dir).find((name) => name.endsWith(".sql"));
		const sql = readFileSync(join(dir, file!), "utf8");

		// A missing NOT NULL on design_session_id or garment_ref is invisible
		// until a row appears with no traceable origin, and shared-03 stops when
		// it finds one.
		for (const column of ["design_session_id", "pattern_ref", "garment_ref", "garment_regions", "model_metadata"]) {
			expect(sql).toMatch(new RegExp(`\`${column}\` text NOT NULL`));
		}
		// And the two that must stay nullable.
		expect(sql).toMatch(/`image_r2_key` text,/);
		expect(sql).toMatch(/`cost_usd` real,/);
	});
});

describe("startRun / completeRun", () => {
	it("opens one row as running and settles it", async () => {
		const db = createTestDb();
		await startRun(asDb(db), "p1", "design-1", "iris/p.jpg", "https://e.com/s.jpg", PLACEMENT, { model: "m" });

		let run = await getRun(asDb(db), "p1");
		expect(run?.status).toBe("running");
		expect(run?.imageR2Key).toBeNull();
		expect(run?.completedAt).toBeNull();
		expect(run?.garmentRegions).toEqual(PLACEMENT);

		await completeRun(asDb(db), "p1", "atlas/p1.jpg", 0.003, { model: "m", steps: 4 });

		run = await getRun(asDb(db), "p1");
		expect(run?.status).toBe("completed");
		expect(run?.imageR2Key).toBe("atlas/p1.jpg");
		expect(run?.costUsd).toBe(0.003);
		expect(run?.completedAt).toBeInstanceOf(Date);
	});

	it("writes exactly one row per invocation, never two", async () => {
		const db = createTestDb();
		await startRun(asDb(db), "p1", "design-1", "iris/p.jpg", "https://e.com/s.jpg", PLACEMENT, {});
		await completeRun(asDb(db), "p1", "atlas/p1.jpg", 0.003, {});

		// The regression guard for somebody reintroducing a second row out of
		// symmetry with Iris. ADR-ATLAS-0001.
		expect(await listRuns(asDb(db))).toHaveLength(1);
	});

	it("records both refs and the design it belongs to", async () => {
		const db = createTestDb();
		await startRun(asDb(db), "p1", "design-42", "iris/x.jpg", "https://e.com/shirt.jpg", PLACEMENT, {});

		const run = await getRun(asDb(db), "p1");
		expect(run?.designSessionId).toBe("design-42");
		expect(run?.patternRef).toBe("iris/x.jpg");
		expect(run?.garmentRef).toBe("https://e.com/shirt.jpg");
	});
});

describe("getRun", () => {
	it("returns undefined for an unknown id", async () => {
		const db = createTestDb();
		expect(await getRun(asDb(db), "nope")).toBeUndefined();
	});
});

describe("insertFailedRun", () => {
	it("leaves a failed row behind when opening the row is what failed", async () => {
		const db = createTestDb();
		await insertFailedRun(asDb(db), "p1", "design-1", "iris/p.jpg", "https://e.com/s.jpg", PLACEMENT, {});

		const run = await getRun(asDb(db), "p1");
		// Atlas has one row per invocation, so without this rescue a failed
		// invocation leaves no trace at all.
		expect(run?.status).toBe("failed");
		expect(run?.completedAt).toBeInstanceOf(Date);
		expect(run?.garmentRegions).toEqual(PLACEMENT);
	});
});

describe("failRunningRuns", () => {
	it("writes the already-spent cost through onto the failed row", async () => {
		const db = createTestDb();
		await startRun(asDb(db), "p1", "design-1", "iris/p.jpg", "https://e.com/s.jpg", PLACEMENT, {});

		// The call billed, then the R2 save broke. The money left the account and
		// has to be recorded, or a spent call reads as having cost nothing.
		await failRunningRuns(asDb(db), "p1", 0.0031);

		const run = await getRun(asDb(db), "p1");
		expect(run?.status).toBe("failed");
		expect(run?.costUsd).toBe(0.0031);
	});

	it("does not overwrite a cost with null when there is nothing spent", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "p1", status: "running", costUsd: 0.002 });

		await failRunningRuns(asDb(db), "p1", null);

		expect((await getRun(asDb(db), "p1"))?.costUsd).toBe(0.002);
	});

	it("leaves settled rows alone", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "done", status: "completed" });
		await failRunningRuns(asDb(db), "done", 0.5);

		expect((await getRun(asDb(db), "done"))?.status).toBe("completed");
	});
});

describe("countResumeAttempts", () => {
	it("counts by root, not by resumed_from", async () => {
		const db = createTestDb();
		// A resume chain: each attempt's immediate parent differs, but every one
		// shares the same root. Counting `resumed_from` would return 1 for each
		// and let the chain spend without limit.
		await insertRow(db, { pipelineId: "orig", modelMetadata: {} });
		await insertRow(db, { pipelineId: "r1", modelMetadata: { root: "orig", resumed_from: "orig", attempt: 1 } });
		await insertRow(db, { pipelineId: "r2", modelMetadata: { root: "orig", resumed_from: "r1", attempt: 2 } });
		await insertRow(db, { pipelineId: "r3", modelMetadata: { root: "orig", resumed_from: "r2", attempt: 3 } });

		expect(await countResumeAttempts(asDb(db), "orig")).toBe(3);
	});

	it("does not count the original, so a cap of 3 means three retries", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "orig", modelMetadata: {} });

		expect(await countResumeAttempts(asDb(db), "orig")).toBe(0);
	});

	it("does not count another brief's resumes", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "r1", modelMetadata: { root: "orig" } });
		await insertRow(db, { pipelineId: "r2", modelMetadata: { root: "other" } });

		expect(await countResumeAttempts(asDb(db), "orig")).toBe(1);
	});
});

describe("getSettledRows", () => {
	it("excludes running rows", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "a", status: "completed" });
		await insertRow(db, { pipelineId: "b", status: "failed" });
		await insertRow(db, { pipelineId: "c", status: "running" });

		const rows = await getSettledRows(asDb(db));

		// A running row exported early would freeze a null cost into D1 forever,
		// because onConflictDoNothing never updates (ADR-0010).
		expect(rows.map((r) => r.pipelineId).sort()).toEqual(["a", "b"]);
	});
});

describe("pruneCompletedRuns", () => {
	const at = (seconds: number) => new Date(seconds * 1000);

	it("keeps exactly the limit and prunes the one beyond it", async () => {
		const db = createTestDb();
		for (let i = 1; i <= 6; i++) {
			await insertRow(db, { pipelineId: `p${i}`, status: "completed", createdAt: at(i) });
		}

		// The boundary, not merely "pruning happened": 5 kept, the 6th gone.
		expect(await pruneCompletedRuns(asDb(db), 5)).toBe(1);

		const left = (await listRuns(asDb(db))).map((r) => r.pipelineId).sort();
		expect(left).toEqual(["p2", "p3", "p4", "p5", "p6"]);
	});

	it("deletes nothing when the count equals the limit", async () => {
		const db = createTestDb();
		for (let i = 1; i <= 5; i++) {
			await insertRow(db, { pipelineId: `p${i}`, status: "completed", createdAt: at(i) });
		}

		expect(await pruneCompletedRuns(asDb(db), 5)).toBe(0);
		expect(await listRuns(asDb(db))).toHaveLength(5);
	});

	it("never prunes a failed run, at any age", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "old-failure", status: "failed", createdAt: at(1) });
		for (let i = 2; i <= 8; i++) {
			await insertRow(db, { pipelineId: `p${i}`, status: "completed", createdAt: at(i) });
		}

		await pruneCompletedRuns(asDb(db), 2);

		// The failure is the thing somebody came back for, and what makes a
		// resume possible days later.
		const left = (await listRuns(asDb(db))).map((r) => r.pipelineId);
		expect(left).toContain("old-failure");
	});

	it("leaves a running row alone — an in-flight invocation is not garbage", async () => {
		const db = createTestDb();
		await insertRow(db, { pipelineId: "inflight", status: "running", createdAt: at(1) });
		for (let i = 2; i <= 5; i++) {
			await insertRow(db, { pipelineId: `p${i}`, status: "completed", createdAt: at(i) });
		}

		await pruneCompletedRuns(asDb(db), 1);

		expect((await listRuns(asDb(db))).map((r) => r.pipelineId)).toContain("inflight");
	});
});
