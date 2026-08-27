import { describe, expect, it } from "vitest";
import { heliosRuns } from "../db/schema";
import { getD1Db } from "../db/client";
import { getRunRows, getSettledRows } from "./do.repository";
import { exportRuns, readRun } from "./d1.repository";
import { createTestD1, createTestDb, insertRow } from "./test-db";

/**
 * The D1 half of the repository, split out of `do.repository.test.ts` once that
 * file passed 280 lines.
 *
 * The D1 handle is a real `createTestD1` through `getD1Db`, not a `createTestDb`
 * standing in for one. Those are two different Drizzle instances and the tests
 * used to bridge them with `as never` — which also switched off checking of the
 * rows argument in the same call (AGENTS.md §4).
 */

describe("exportRuns (idempotency)", () => {
	it("calling exportRuns twice with the same rows inserts once", async () => {
		const doDb = createTestDb();
		const d1Db = getD1Db(createTestD1());
		await insertRow(doDb, { pInvocId: "run-a", modality: "text" });
		await insertRow(doDb, { pInvocId: "run-a", modality: "image" });

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
	 * D1 caps a query at 100 bound parameters and `helios_runs` binds 11 per row,
	 * so `exportRuns` chunks at nine. 25 rows crosses that boundary twice and
	 * ends mid-chunk, which is where an off-by-one in the slice would show up.
	 *
	 * Note what this does **not** prove: `node:sqlite` has no 100-parameter cap,
	 * so a wrong `MAX_ROWS_PER_INSERT` still passes here. The constant's
	 * correctness rests on the arithmetic in its comment and on review.
	 */
	it("exports every row when there are more than one insert can carry", async () => {
		const doDb = createTestDb();
		const d1Db = getD1Db(createTestD1());
		for (let i = 0; i < 25; i++) {
			await insertRow(doDb, { pInvocId: `run-${i}`, modality: "text" });
		}

		await exportRuns(d1Db, await getSettledRows(doDb));

		expect(await d1Db.select().from(heliosRuns)).toHaveLength(25);
	});
});

describe("readRun", () => {
	it("reads back exactly what was exported, through code rather than a hand-typed query", async () => {
		const doDb = createTestDb();
		const d1Db = getD1Db(createTestD1());
		await insertRow(doDb, { pInvocId: "run-a", modality: "text", status: "completed" });
		await insertRow(doDb, { pInvocId: "run-a", modality: "image", status: "failed" });
		await insertRow(doDb, { pInvocId: "run-b", modality: "text", status: "completed" });

		await exportRuns(d1Db, await getSettledRows(doDb));

		const readBack = await readRun(d1Db, "run-a");

		expect(readBack).toHaveLength(2);
		expect(readBack.every((row) => row.pInvocId === "run-a")).toBe(true);
		expect(readBack.map((row) => row.status).sort()).toEqual(["completed", "failed"]);
		expect(readBack.map((row) => row.modality).sort()).toEqual(["image", "text"]);
	});

	it("returns an empty array for a run that was never exported", async () => {
		const d1Db = getD1Db(createTestD1());

		expect(await readRun(d1Db, "never-happened")).toEqual([]);
	});
});
