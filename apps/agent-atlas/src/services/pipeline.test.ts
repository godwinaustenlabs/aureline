import { beforeEach, describe, expect, it, vi } from "vitest";
import { AtlasResultSchema, type AtlasPlacement, type AtlasRequest } from "@aureline/shared-types";
import { runPipeline, runImageStage } from "./pipeline";
import { placePattern } from "./placer";
import { startRun, listRuns, getRun } from "../repository/do.repository";
import { createTestDb } from "../repository/test-db";
import type { AtlasDb } from "../db/client";
import { resolveConfig } from "../config";

// The placer and the storage writes are imported by pipeline.ts, so mocking
// these two modules (with a delegate that calls the real thing by default) is
// how a test injects a failure and `pipeline.ts` sees it. The delegate keeps
// every other test on the real implementation.
vi.mock("./placer", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./placer")>();
	return { ...actual, placePattern: vi.fn(actual.placePattern) };
});

vi.mock("../repository/do.repository", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../repository/do.repository")>();
	return { ...actual, startRun: vi.fn(actual.startRun) };
});

/** The runtime config vars `resolveConfig` falls back to when KV is empty. */
const VARS = {
	IMAGE_MODEL: "@cf/black-forest-labs/flux-2-klein-9b",
	AI_GATEWAY_ID: "atlas",
	MAX_RETRIES: "2",
	RETENTION_LIMIT: "5",
	MAX_RESUME_ATTEMPTS: "3",
};

const ORIGIN = "http://localhost:8787";

const REQ: AtlasRequest = {
	pattern_ref: "iris/iris-abc.jpg",
	garment_ref: "https://example.com/shirt.jpg",
	design_session_id: "design-abc",
	garment_type: "tshirt",
	regions: ["back", "hem"],
	coverage: "allover",
	pattern_scale: "medium",
};

/**
 * Fake `Env`. Nothing in this ticket may reach a model, so **`AI.run` throws if
 * it is called at all** — a test that would silently start billing when
 * atlas-07 lands is worse than no test.
 *
 * The D1 binding throws by default so `exportAndPrune`'s try/catch swallows it,
 * matching "a failed export does not fail the run".
 */
function fakeEnv(overrides: { patternsPut?: "ok" | "fail" } = {}) {
	return {
		...VARS,
		AI: {
			run: vi.fn(async () => {
				throw new Error("the AI binding must never be reached in atlas-06");
			}),
		},
		CONFIG: { get: vi.fn(async (keys: string[]) => new Map(keys.map((k) => [k, null]))) },
		PATTERNS: {
			put: vi.fn(async () => {
				if (overrides.patternsPut === "fail") throw new Error("R2 unavailable");
				return {};
			}),
			get: vi.fn(async () => null),
		},
		DB: {
			prepare: vi.fn(() => {
				throw new Error("D1 unavailable in tests");
			}),
		},
	} as unknown as Env;
}

const asDb = (db: ReturnType<typeof createTestDb>) => db as unknown as AtlasDb;

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("runPipeline, the happy path", () => {
	it("returns a completed AtlasResult that validates against the schema", async () => {
		const db = createTestDb();

		const result = await runPipeline(asDb(db), REQ, fakeEnv(), ORIGIN);

		expect(() => AtlasResultSchema.parse(result)).not.toThrow();
		expect(result.status).toBe("completed");
		expect(result.error).toBeNull();
		expect(result.design_session_id).toBe("design-abc");
		expect(result.image_url).toBe(`${ORIGIN}/images/atlas/${result.pipeline_id}.jpg`);
		expect(result.width).toBe(512);
		expect(result.height).toBe(512);
		// The fake billed nothing. atlas-07 replaces this with the gateway's figure.
		expect(result.cost_usd).toBeNull();
	});

	it("writes exactly ONE row per invocation", async () => {
		const db = createTestDb();

		await runPipeline(asDb(db), REQ, fakeEnv(), ORIGIN);

		// The guard against somebody reintroducing a second row out of symmetry
		// with Iris. ADR-ATLAS-0001.
		expect(await listRuns(asDb(db))).toHaveLength(1);
	});

	it("records the placement, both refs and the upstream run on the row", async () => {
		const db = createTestDb();

		const result = await runPipeline(asDb(db), REQ, fakeEnv(), ORIGIN);
		const run = await getRun(asDb(db), result.pipeline_id);

		expect(run?.status).toBe("completed");
		expect(run?.designSessionId).toBe("design-abc");
		expect(run?.patternRef).toBe("iris/iris-abc.jpg");
		expect(run?.garmentRef).toBe("https://example.com/shirt.jpg");
		expect(run?.imageR2Key).toBe(`atlas/${result.pipeline_id}.jpg`);
		expect(run?.garmentRegions).toMatchObject({
			garment_type: "tshirt",
			regions: ["back", "hem"],
			coverage: "allover",
			pattern_scale: "medium",
			prompt_version: "atlas-placement-v1",
		});
	});

	it("mints a fresh pipeline_id per invocation, not one per Durable Object", async () => {
		const db = createTestDb();

		const a = await runPipeline(asDb(db), REQ, fakeEnv(), ORIGIN);
		const b = await runPipeline(asDb(db), REQ, fakeEnv(), ORIGIN);

		// One DO accumulates many invocations (ADR-0005).
		expect(a.pipeline_id).not.toBe(b.pipeline_id);
		expect(await listRuns(asDb(db))).toHaveLength(2);
	});

	it("never reaches the AI binding", async () => {
		const db = createTestDb();
		const env = fakeEnv();

		await runPipeline(asDb(db), REQ, env, ORIGIN);

		expect((env.AI as unknown as { run: ReturnType<typeof vi.fn> }).run).not.toHaveBeenCalled();
	});
});

describe("runPipeline refuses an impossible request before anything bills", () => {
	it("rejects a sleeve on a scarf at the validate stage", async () => {
		const db = createTestDb();

		const result = await runPipeline(
			asDb(db),
			{ ...REQ, garment_type: "scarf", regions: ["sleeve"] },
			fakeEnv(),
			ORIGIN,
		);

		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/^validate: /);
		expect(result.error).toMatch(/scarf has no sleeve/);
	});

	it("never opens a row for a refused request", async () => {
		const db = createTestDb();

		await runPipeline(asDb(db), { ...REQ, garment_type: "scarf", regions: ["sleeve"] }, fakeEnv(), ORIGIN);

		// Nothing ran, so nothing is left behind — and in particular nothing is
		// left `running`.
		expect(await listRuns(asDb(db))).toHaveLength(0);
		expect(vi.mocked(placePattern)).not.toHaveBeenCalled();
	});

	it("does not reach the image stage", async () => {
		const db = createTestDb();

		await runPipeline(asDb(db), { ...REQ, garment_type: "dress", regions: ["sleeve"] }, fakeEnv(), ORIGIN);

		expect(vi.mocked(placePattern)).not.toHaveBeenCalled();
	});
});

describe("runPipeline on failure", () => {
	it("returns a settled failed result with the stage prefixed, not a throw", async () => {
		const db = createTestDb();
		vi.mocked(placePattern).mockRejectedValueOnce(new Error("model exploded"));

		const result = await runPipeline(asDb(db), REQ, fakeEnv(), ORIGIN);

		expect(result.status).toBe("failed");
		expect(result.error).toBe("image: model exploded");
		expect(result.image_url).toBeNull();
		expect(result.width).toBeNull();
	});

	it("keeps the placement on a failure, so the run stays inspectable", async () => {
		const db = createTestDb();
		vi.mocked(placePattern).mockRejectedValueOnce(new Error("model exploded"));

		const result = await runPipeline(asDb(db), REQ, fakeEnv(), ORIGIN);

		expect(result.placement).not.toBeNull();
		expect(result.placement?.prompt_version).toBe("atlas-placement-v1");
	});

	it("leaves exactly one failed row with the placement recorded", async () => {
		const db = createTestDb();
		vi.mocked(placePattern).mockRejectedValueOnce(new Error("model exploded"));

		const result = await runPipeline(asDb(db), REQ, fakeEnv(), ORIGIN);

		const rows = await listRuns(asDb(db));
		expect(rows).toHaveLength(1);
		expect(rows[0]!.status).toBe("failed");
		expect(rows[0]!.pipelineId).toBe(result.pipeline_id);
		expect(rows[0]!.garmentRegions).toMatchObject({ garment_type: "tshirt" });
	});

	it("reports the cost when the call billed and a later step broke", async () => {
		const db = createTestDb();
		// The call succeeds and bills, then the R2 save fails. The money left the
		// account, so a result claiming it cost nothing would be a lie.
		vi.mocked(placePattern).mockResolvedValueOnce({
			image: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
			contentType: "image/jpeg",
			width: 512,
			height: 512,
			cost_usd: 0.0031,
		});

		const result = await runPipeline(asDb(db), REQ, fakeEnv({ patternsPut: "fail" }), ORIGIN);

		expect(result.status).toBe("failed");
		expect(result.cost_usd).toBe(0.0031);
		expect((await getRun(asDb(db), result.pipeline_id))?.costUsd).toBe(0.0031);
	});

	it("still leaves a row behind when opening the row is itself what failed", async () => {
		const db = createTestDb();
		vi.mocked(startRun).mockRejectedValueOnce(new Error("DO storage unavailable"));

		const result = await runPipeline(asDb(db), REQ, fakeEnv(), ORIGIN);

		expect(result.status).toBe("failed");
		// Atlas has one row per invocation, so without the rescue insert a failed
		// invocation would leave no trace at all.
		const rows = await listRuns(asDb(db));
		expect(rows).toHaveLength(1);
		expect(rows[0]!.status).toBe("failed");
	});

	it("returns a settled result rather than throwing when storage is entirely unavailable", async () => {
		const db = createTestDb();
		const broken = {
			insert: () => { throw new Error("storage gone"); },
			update: () => { throw new Error("storage gone"); },
			select: () => { throw new Error("storage gone"); },
			delete: () => { throw new Error("storage gone"); },
		} as unknown as AtlasDb;

		// The HTTP layer only ever deals with settled outcomes, so this must not
		// escape as an opaque 500.
		const result = await runPipeline(broken, REQ, fakeEnv(), ORIGIN);

		expect(result.status).toBe("failed");
		expect(() => AtlasResultSchema.parse(result)).not.toThrow();
	});
});

describe("runImageStage is separately re-enterable, for atlas-08's resume", () => {
	it("can be called on its own with a placement read back from storage", async () => {
		const db = createTestDb();
		const env = fakeEnv();
		const config = await resolveConfig(env);
		const placement: AtlasPlacement = {
			garment_type: "tshirt",
			regions: ["back"],
			coverage: "allover",
			pattern_scale: "medium",
			prompt_version: "atlas-placement-v1",
		};

		const outcome = await runImageStage(
			asDb(db), env, config, "resumed-1", "design-abc",
			"iris/iris-abc.jpg", "https://example.com/shirt.jpg", placement,
			// The resume markers, which have to land on this row because it is the
			// only row there is.
			{ root: "orig", resumed_from: "orig", attempt: 1 },
		);

		expect(outcome.ok).toBe(true);
		const run = await getRun(asDb(db), "resumed-1");
		expect(run?.modelMetadata).toMatchObject({ root: "orig", resumed_from: "orig", attempt: 1 });
	});

	it("returns an outcome rather than throwing, so the caller decides", async () => {
		const db = createTestDb();
		const env = fakeEnv();
		const config = await resolveConfig(env);
		vi.mocked(placePattern).mockRejectedValueOnce(new Error("nope"));

		const outcome = await runImageStage(
			asDb(db), env, config, "p1", "design-abc",
			"iris/p.jpg", "https://example.com/s.jpg",
			{ garment_type: "tshirt", regions: ["back"], coverage: "allover", pattern_scale: "medium", prompt_version: "v1" },
		);

		expect(outcome.ok).toBe(false);
	});
});
