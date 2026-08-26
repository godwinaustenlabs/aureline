import { getTableColumns } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { irisRuns } from "../db/schema";
import { getD1Db } from "../db/client";
import { D1_BOUND_PARAMETER_LIMIT, MAX_ROWS_PER_INSERT, exportRuns, readRun } from "./d1.repository";
import { getSettledRows, pruneCompletedRuns } from "./do.repository";
import { createTestD1, createTestDb, insertRow } from "./test-db";
import { exportAndPrune } from "../services/pipeline";
import { fakeEnv } from "../services/test-env";
import { sampleParamsFull } from "../fixtures/sample-params";

// Delegates that call the real thing, so every test below runs against the real
// implementations and only the ordering test swaps one out. `exportAndPrune`
// imports both of these modules, which is how a rejection injected here is
// visible to it.
vi.mock("./d1.repository", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./d1.repository")>();
	return { ...actual, exportRuns: vi.fn(actual.exportRuns) };
});

vi.mock("./do.repository", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./do.repository")>();
	return { ...actual, pruneCompletedRuns: vi.fn(actual.pruneCompletedRuns) };
});

/** Both rows of one settled invocation, ordered so `created_at` is deterministic. */
async function seedRun(
	db: ReturnType<typeof createTestDb>,
	pipelineId: string,
	overrides: { status?: "completed" | "failed" | "running"; createdAt?: Date; designSessionId?: string } = {},
) {
	const createdAt = overrides.createdAt ?? new Date(1_000_000);
	const common = {
		status: overrides.status ?? ("completed" as const),
		designSessionId: overrides.designSessionId ?? "design-1",
		plannerParams: sampleParamsFull,
	};

	await insertRow(db, { ...common, pipelineId, modality: "text", createdAt });
	await insertRow(db, {
		...common,
		pipelineId,
		modality: "image",
		createdAt: new Date(createdAt.getTime() + 10),
	});
}

describe("exportRuns", () => {
	let db: ReturnType<typeof createTestDb>;
	let d1: ReturnType<typeof getD1Db>;

	beforeEach(() => {
		vi.clearAllMocks();
		db = createTestDb();
		d1 = getD1Db(createTestD1());
	});

	it("writes settled rows into D1", async () => {
		await seedRun(db, "run-a");

		await exportRuns(d1, await getSettledRows(db));

		const exported = await d1.select().from(irisRuns);
		expect(exported).toHaveLength(2);
		expect(exported.map((row) => row.modality).sort()).toEqual(["image", "text"]);
	});

	it("is safe to run twice: a repeat conflicts on the primary key and writes nothing", async () => {
		await seedRun(db, "run-a");
		const rows = await getSettledRows(db);

		await exportRuns(d1, rows);
		await exportRuns(d1, rows);

		// Idempotency is what makes a partway-through failure safe to retry, and
		// it is why a failed export needs no recovery route of its own: the next
		// invocation's export sweeps the same rows up again.
		expect(await d1.select().from(irisRuns)).toHaveLength(2);
	});

	it("carries every row across when there are more than one statement can hold", async () => {
		// Fifteen rows, not a token two. The chunk size is seven, so anything at
		// or under eight passes whether the constant is Iris's 7 or Helios's 9 and
		// proves nothing about the chunking loop running more than once.
		for (let i = 0; i < 15; i++) {
			await insertRow(db, {
				pipelineId: `run-${i}`,
				modality: "text",
				plannerParams: sampleParamsFull,
				createdAt: new Date(1_000_000 + i * 1000),
			});
		}

		await exportRuns(d1, await getSettledRows(db));

		expect(await d1.select().from(irisRuns)).toHaveLength(15);
	});

	it("never carries a running row, because getSettledRows is the filter", async () => {
		await seedRun(db, "settled");
		await insertRow(db, { pipelineId: "in-flight", modality: "text", status: "running" });

		// Fed the real `getSettledRows` output rather than a hand-picked array:
		// the guarantee under test is that the two functions compose, not that
		// this test remembered to leave the running row out.
		await exportRuns(d1, await getSettledRows(db));

		const exported = await d1.select().from(irisRuns);
		expect(exported.map((row) => row.pipelineId)).toEqual(["settled", "settled"]);
		// A `running` row exported early would be frozen that way forever:
		// `onConflictDoNothing` never updates, so its null cost would stand even
		// after the run settled (ADR-0010).
		expect(exported.some((row) => row.status === "running")).toBe(false);
	});
});

describe("MAX_ROWS_PER_INSERT", () => {
	it("is small enough that a full chunk stays under D1's bound parameter limit", async () => {
		// Re-derived from the schema, not asserted as a literal. The chunking test
		// above cannot catch a wrong value: it runs against `node:sqlite`, which
		// has no parameter cap, so fifteen rows land whether this is 7 or Helios's
		// 9. This is the assertion that fails on a copied 9 (13 x 9 = 117) and on
		// the day someone adds a column without recomputing (AGENTS.md §8).
		const columnCount = Object.keys(getTableColumns(irisRuns)).length;

		expect(columnCount * MAX_ROWS_PER_INSERT).toBeLessThanOrEqual(D1_BOUND_PARAMETER_LIMIT);
		// And not needlessly small: one more row per statement would cross it.
		expect(columnCount * (MAX_ROWS_PER_INSERT + 1)).toBeGreaterThan(D1_BOUND_PARAMETER_LIMIT);
	});
});

describe("readRun", () => {
	let db: ReturnType<typeof createTestDb>;
	let d1: ReturnType<typeof getD1Db>;

	beforeEach(() => {
		vi.clearAllMocks();
		db = createTestDb();
		d1 = getD1Db(createTestD1());
	});

	it("round-trips an exported run, values intact", async () => {
		await seedRun(db, "run-a", { designSessionId: "design-7" });
		const original = await getSettledRows(db);

		await exportRuns(d1, original);
		const readBack = await readRun(d1, "run-a");

		// Whole-row equality rather than a field or two. The JSON columns and the
		// millisecond timestamps are the parts most likely to survive a write and
		// come back wrong, and only comparing everything catches that.
		expect(sortById(readBack)).toEqual(sortById(original));
		expect(readBack.every((row) => row.designSessionId === "design-7")).toBe(true);
	});

	it("returns the rows of one run only, not the whole table", async () => {
		await seedRun(db, "run-a");
		await seedRun(db, "run-b", { createdAt: new Date(2_000_000) });

		await exportRuns(d1, await getSettledRows(db));

		expect((await readRun(d1, "run-a")).map((row) => row.pipelineId)).toEqual(["run-a", "run-a"]);
	});

	it("returns an empty array for a run that is not there", async () => {
		expect(await readRun(d1, "never-happened")).toEqual([]);
	});
});

describe("exportAndPrune", () => {
	let db: ReturnType<typeof createTestDb>;

	beforeEach(() => {
		vi.clearAllMocks();
		db = createTestDb();
	});

	it("exports the whole DO and then prunes it down to the limit", async () => {
		const { env, d1 } = fakeEnv();
		for (let i = 0; i < 4; i++) {
			await seedRun(db, `run-${i}`, { createdAt: new Date(1_000_000 + i * 1000) });
		}

		await exportAndPrune(db, env, "run-3", 2);

		// Everything is in D1, including the two runs that no longer exist in the
		// DO. That is the entire point of doing it in this order.
		const exported = await getD1Db(d1).select().from(irisRuns);
		expect(exported).toHaveLength(8);

		const remaining = await db.select().from(irisRuns);
		expect([...new Set(remaining.map((row) => row.pipelineId))].sort()).toEqual(["run-2", "run-3"]);
	});

	it("does not prune when the export failed", async () => {
		const { env } = fakeEnv();
		for (let i = 0; i < 4; i++) {
			await seedRun(db, `run-${i}`, { createdAt: new Date(1_000_000 + i * 1000) });
		}

		vi.mocked(exportRuns).mockRejectedValueOnce(new Error("d1 unreachable"));

		await exportAndPrune(db, env, "run-3", 2);

		// The ordering is the decision ADR-0010 records, and two adjacent lines
		// are exactly the kind of thing someone reorders while tidying up. Testing
		// export and prune separately would not have noticed.
		expect(vi.mocked(pruneCompletedRuns)).not.toHaveBeenCalled();
		expect(await db.select().from(irisRuns)).toHaveLength(8);
	});

	it("swallows an export failure rather than costing the caller their result", async () => {
		// A D1 binding that throws on first contact, which is what an outage looks
		// like from in here.
		const { env } = fakeEnv({ throwingD1: true });
		await seedRun(db, "run-a");

		// Resolves. `exportAndPrune` is called from inside runPipeline's try and
		// from its catch, and a throw out of a catch escapes the function: the run
		// already happened and the money is already spent.
		await expect(exportAndPrune(db, env, "run-a", 2)).resolves.toBeUndefined();

		// The rows stay put, so the next invocation's export picks them up.
		expect(await db.select().from(irisRuns)).toHaveLength(2);
	});

	it("passes the caller's retention limit through, not the one in env", async () => {
		const { env } = fakeEnv();
		for (let i = 0; i < 3; i++) {
			await seedRun(db, `run-${i}`, { createdAt: new Date(1_000_000 + i * 1000) });
		}

		// `env.RETENTION_LIMIT` is "5", which would prune nothing. A 1 reaching
		// the repository is the only way two runs get deleted, so this fails if
		// anyone ever reads config from `env` down here instead (ADR-0008).
		await exportAndPrune(db, env, "run-2", 1);

		expect(vi.mocked(pruneCompletedRuns)).toHaveBeenCalledWith(db, 1);
		expect(await db.select().from(irisRuns)).toHaveLength(2);
	});
});

/** Row order is not part of either function's contract, so equality checks fix it. */
function sortById<T extends { id: string }>(rows: T[]): T[] {
	return [...rows].sort((a, b) => a.id.localeCompare(b.id));
}
