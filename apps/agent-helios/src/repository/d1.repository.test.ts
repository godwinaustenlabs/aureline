import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { heliosRuns } from "../db/schema";
import { getD1Db } from "../db/client";
import { getRunRows, getSettledRows } from "./do.repository";
import { exportRuns, readRun, MAX_ROWS_PER_INSERT } from "./d1.repository";
import { createTestD1, createTestDb, insertRow } from "./test-db";

/**
 * The D1 half of the repository, split out of `do.repository.test.ts` once that
 * file passed 280 lines.
 *
 * The D1 handle is a real `createTestD1` through `getD1Db`, not a `createTestDb`
 * standing in for one. Those are two different Drizzle instances and the tests
 * used to bridge them with `as never` at each call site, which is what
 * `test-db.ts` now spends a single documented cast to avoid (AGENTS.md §4).
 */

describe("exportRuns (idempotency)", () => {
	it("calling exportRuns twice with the same rows inserts once", async () => {
		const doDb = createTestDb();
		const d1Db = getD1Db(createTestD1());
		await insertRow(doDb, { pipelineId: "run-a", modality: "text" });
		await insertRow(doDb, { pipelineId: "run-a", modality: "image" });

		const rows = await getRunRows(doDb, "run-a");

		await exportRuns(d1Db, rows);
		await exportRuns(d1Db, rows);

		const exported = await d1Db.select().from(heliosRuns);
		expect(exported).toHaveLength(2);
	});

	it("exports nothing, without erroring, when there is nothing settled", async () => {
		const d1Db = getD1Db(createTestD1());

		await exportRuns(d1Db, []);

		expect(await d1Db.select().from(heliosRuns)).toHaveLength(0);
	});

	/**
	 * D1 caps a statement at 100 bound parameters and `helios_runs` binds 13 per
	 * row, so `exportRuns` chunks at seven. 25 rows crosses that boundary three
	 * times and ends mid-chunk, which is where an off-by-one in the slice shows up.
	 *
	 * Note what this does **not** prove: `node:sqlite` has no 100-parameter cap,
	 * so a wrong `MAX_ROWS_PER_INSERT` still passes here. That is what the test
	 * below it is for.
	 */
	it("exports every row when there are more than one insert can carry", async () => {
		const doDb = createTestDb();
		const d1Db = getD1Db(createTestD1());
		for (let i = 0; i < 25; i++) {
			await insertRow(doDb, { pipelineId: `run-${i}`, modality: "text" });
		}

		await exportRuns(d1Db, await getSettledRows(doDb));

		expect(await d1Db.select().from(heliosRuns)).toHaveLength(25);
	});
});

describe("MAX_ROWS_PER_INSERT", () => {
	/**
	 * The one check that can actually fail when someone adds a column.
	 *
	 * Exporting rows through the test fake cannot catch a wrong constant, because
	 * `node:sqlite` has no parameter cap — and in production the failure is
	 * swallowed by `exportAndPrune` and reported as a completed run. So the
	 * invariant is asserted directly, against the column count Drizzle reports
	 * rather than a number repeated here.
	 *
	 * Adding a 14th column without dropping this to 6 fails this test instead of
	 * silently ending the export of every session that has seven settled rows.
	 * `classification` was the 13th and took the constant from 8 to 7.
	 */
	it("stays under D1's 100-parameter cap for the schema as it actually is", () => {
		const columnCount = Object.keys(getTableColumns(heliosRuns)).length;

		expect(columnCount).toBe(13);
		expect(columnCount * MAX_ROWS_PER_INSERT).toBeLessThanOrEqual(100);

		// And is not needlessly small: one more row per statement would breach it.
		expect(columnCount * (MAX_ROWS_PER_INSERT + 1)).toBeGreaterThan(100);
	});
});

describe("readRun", () => {
	it("reads back exactly what was exported, through code rather than a hand-typed query", async () => {
		const doDb = createTestDb();
		const d1Db = getD1Db(createTestD1());
		await insertRow(doDb, { pipelineId: "run-a", modality: "text", status: "completed" });
		await insertRow(doDb, { pipelineId: "run-a", modality: "image", status: "failed" });
		await insertRow(doDb, { pipelineId: "run-b", modality: "text", status: "completed" });

		await exportRuns(d1Db, await getSettledRows(doDb));

		const readBack = await readRun(d1Db, "run-a");

		expect(readBack).toHaveLength(2);
		expect(readBack.every((row) => row.pipelineId === "run-a")).toBe(true);
		expect(readBack.map((row) => row.status).sort()).toEqual(["completed", "failed"]);
		expect(readBack.map((row) => row.modality).sort()).toEqual(["image", "text"]);
	});

	it("carries design_session_id through the export, so a design stays traceable in D1", async () => {
		const doDb = createTestDb();
		const d1Db = getD1Db(createTestD1());
		// Two runs of the same design, which is what a resume produces. The whole
		// point of the column is that D1 can group them back together.
		await insertRow(doDb, { pipelineId: "run-a", modality: "text", designSessionId: "design-9" });
		await insertRow(doDb, { pipelineId: "run-a", modality: "image", designSessionId: "design-9" });
		await insertRow(doDb, { pipelineId: "run-b", modality: "text", designSessionId: "design-9" });
		await insertRow(doDb, { pipelineId: "run-c", modality: "text", designSessionId: "a-different-design" });

		await exportRuns(d1Db, await getSettledRows(doDb));

		const exported = await d1Db.select().from(heliosRuns);
		const ofDesign = exported.filter((row) => row.designSessionId === "design-9");

		expect(ofDesign).toHaveLength(3);
		expect([...new Set(ofDesign.map((row) => row.pipelineId))].sort()).toEqual(["run-a", "run-b"]);
	});

	it("returns an empty array for a run that was never exported", async () => {
		const d1Db = getD1Db(createTestD1());

		expect(await readRun(d1Db, "never-happened")).toEqual([]);
	});
});
