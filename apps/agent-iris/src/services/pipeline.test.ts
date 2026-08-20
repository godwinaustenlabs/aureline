import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IrisRequest } from "@aureline/shared-types";
import { runPipeline } from "./pipeline";
import { planConcept } from "./planner";
import { colorizeMotif } from "./colorizer";
import { startTextRun, failRunningRuns, startImageRun } from "../repository/do.repository";
import { irisRuns } from "../db/schema";
import { createTestDb, insertRow } from "../repository/test-db";
import { sampleParamsFull } from "../fixtures/sample-params";
import { json } from "../http";

// The planner, the colorizer and the storage writes are imported by
// pipeline.ts, so mocking these modules (with a delegate that calls the real
// thing by default) is how a test injects a failure and pipeline.ts sees it.
// The delegate keeps every other test on the real implementation.
vi.mock("./planner", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./planner")>();
	return { ...actual, planConcept: vi.fn(actual.planConcept) };
});

vi.mock("./colorizer", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./colorizer")>();
	return { ...actual, colorizeMotif: vi.fn(actual.colorizeMotif) };
});

vi.mock("../repository/do.repository", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../repository/do.repository")>();
	return {
		...actual,
		startTextRun: vi.fn(actual.startTextRun),
		failRunningRuns: vi.fn(actual.failRunningRuns),
		startImageRun: vi.fn(actual.startImageRun),
	};
});

/** The runtime config vars `resolveConfig` falls back to when KV is empty. */
const VARS = {
	PLANNER_MODEL: "@cf/openai/gpt-oss-120b",
	IMAGE_MODEL: "@cf/black-forest-labs/flux-2-klein-9b",
	AI_GATEWAY_ID: "iris",
	MAX_RETRIES: "2",
	RETENTION_LIMIT: "5",
	MAX_RESUME_ATTEMPTS: "3",
};

const ORIGIN = "http://localhost:8787";

const REQ: IrisRequest = {
	concept: "art deco paisley in deep jewel tones",
	motif_ref: "patterns/fake.jpg",
	source_p_invoc_id: "helios-test-1",
};

/**
 * Fake `Env` for the whole pipeline. Nothing in this ticket should reach a
 * model — both `planConcept` and `colorizeMotif` are faked function bodies
 * that never touch `env.AI` — so `AI.run` is a fake that **throws if called**.
 * A test that would silently start billing when iris-08/iris-09 land is worse
 * than no test.
 *
 * Storage, KV and R2 are stubbed. D1 (`env.DB`) is never touched:
 * `exportAndPrune` is a no-op until iris-11.
 */
function fakeEnv() {
	const run = vi.fn(async () => {
		throw new Error("AI.run must never be called by the fakes in iris-05");
	});

	const patternsPut = vi.fn().mockResolvedValue({});

	const env = {
		AI: { run, gateway: vi.fn(), aiGatewayLogId: null },
		AI_GATEWAY_ID: VARS.AI_GATEWAY_ID,
		// Empty KV → every value resolves from the vars above.
		CONFIG: { get: vi.fn().mockResolvedValue(new Map<string, string | null>()) },
		PATTERNS: { put: patternsPut, get: vi.fn() },
		DB: {},
		PLANNER_MODEL: VARS.PLANNER_MODEL,
		IMAGE_MODEL: VARS.IMAGE_MODEL,
		MAX_RETRIES: VARS.MAX_RETRIES,
		RETENTION_LIMIT: VARS.RETENTION_LIMIT,
		MAX_RESUME_ATTEMPTS: VARS.MAX_RESUME_ATTEMPTS,
	} as unknown as Env;

	return { env, run, patternsPut };
}

async function rowsFor(db: ReturnType<typeof createTestDb>, pInvocId: string) {
	return db.select().from(irisRuns).where(eq(irisRuns.pInvocId, pInvocId));
}

describe("runPipeline", () => {
	let db: ReturnType<typeof createTestDb>;

	beforeEach(() => {
		db = createTestDb();
		// These mocks carry live delegates from `vi.fn(actual.x)`, and several
		// tests queue a `...Once` value. `mockReset` drains that queue and puts
		// the delegate back, so a test that fails before consuming its queued
		// value cannot leak it into the next one.
		vi.mocked(planConcept).mockReset();
		vi.mocked(colorizeMotif).mockReset();
		vi.mocked(startTextRun).mockReset();
		vi.mocked(failRunningRuns).mockReset();
		vi.mocked(startImageRun).mockReset();
	});

	it("completes a happy path with real params, a full image url, and width/height", async () => {
		const { env, run } = fakeEnv();

		const result = await runPipeline(db as never, REQ, env, ORIGIN);

		expect(result.status).toBe("completed");
		expect(result.params).toEqual(sampleParamsFull);
		expect(result.source_p_invoc_id).toBe(REQ.source_p_invoc_id);
		expect(result.image_url).toBe(`${ORIGIN}/images/iris/${result.p_invoc_id}.jpg`);
		expect(result.width).toBe(128);
		expect(result.height).toBe(128);
		expect(result.cost_usd).toBeNull();
		expect(result.error).toBeNull();

		const rows = await rowsFor(db, result.p_invoc_id);
		expect(rows).toHaveLength(2);
		const textRow = rows.find((row) => row.modality === "text");
		const imageRow = rows.find((row) => row.modality === "image");
		expect(textRow?.status).toBe("completed");
		expect(imageRow?.status).toBe("completed");
		expect(imageRow?.motifRef).toBe(REQ.motif_ref);
		expect(textRow?.sourcePInvocId).toBe(REQ.source_p_invoc_id);
		expect(imageRow?.sourcePInvocId).toBe(REQ.source_p_invoc_id);

		// Nothing in this ticket reaches a model.
		expect(run).not.toHaveBeenCalled();
	});

	it("marks a planner failure as one failed text row and one failed image row", async () => {
		const { env } = fakeEnv();
		vi.mocked(planConcept).mockRejectedValueOnce(new Error("boom"));

		const result = await runPipeline(db as never, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");
		expect(result.params).toBeNull();
		expect(result.image_url).toBeNull();
		expect(result.cost_usd).toBeNull();
		expect(result.error).toMatch(/^planner:/);

		const rows = await rowsFor(db, result.p_invoc_id);
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.modality === "text")?.status).toBe("failed");
		expect(rows.find((row) => row.modality === "image")?.status).toBe("failed");
	});

	it("keeps the planner's params on the result when only the image fails", async () => {
		const { env } = fakeEnv();
		vi.mocked(colorizeMotif).mockRejectedValueOnce(new Error("flux down"));

		const result = await runPipeline(db as never, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");
		expect(result.params).toEqual(sampleParamsFull);
		expect(result.image_url).toBeNull();
		expect(result.error).toMatch(/^image:/);

		const rows = await rowsFor(db, result.p_invoc_id);
		const textRow = rows.find((row) => row.modality === "text");
		const imageRow = rows.find((row) => row.modality === "image");
		expect(textRow?.status).toBe("completed");
		expect(textRow?.plannerParams).toEqual(sampleParamsFull);
		expect(imageRow?.status).toBe("failed");
	});

	it("returns a settled failed result when storage itself is unavailable, rather than throwing", async () => {
		const { env } = fakeEnv();
		vi.mocked(startTextRun).mockRejectedValueOnce(new Error("storage down"));
		// The cleanup write breaks too, and must not escape as a throw.
		vi.mocked(failRunningRuns).mockRejectedValueOnce(new Error("cleanup down"));

		const result = await runPipeline(db as never, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/^persist:/);
	});

	it("still records a failed image row when opening that row is what failed", async () => {
		const { env } = fakeEnv();
		vi.mocked(startImageRun).mockRejectedValueOnce(new Error("storage hiccup"));

		const result = await runPipeline(db as never, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/^image:/);
		expect(result.params).toEqual(sampleParamsFull);

		const rows = await rowsFor(db, result.p_invoc_id);
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.modality === "text")?.status).toBe("completed");
		expect(rows.find((row) => row.modality === "image")?.status).toBe("failed");
	});

	it("leaves a concurrent invocation's running row alone", async () => {
		await insertRow(db, { pInvocId: "other-inflight", modality: "text", status: "running" });
		await insertRow(db, { pInvocId: "other-inflight", modality: "image", status: "running" });
		const { env } = fakeEnv();
		vi.mocked(planConcept).mockRejectedValueOnce(new Error("boom"));

		const result = await runPipeline(db as never, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");

		const other = await rowsFor(db, "other-inflight");
		expect(other).toHaveLength(2);
		expect(other.every((row) => row.status === "running")).toBe(true);
	});
});

describe("HTTP layer contract (decision 3)", () => {
	it("returns HTTP 200 for a failed run, not just a body that says failed", async () => {
		const db = createTestDb();
		const { env } = fakeEnv();
		vi.mocked(planConcept).mockReset();
		vi.mocked(planConcept).mockRejectedValueOnce(new Error("boom"));

		const result = await runPipeline(db as never, REQ, env, ORIGIN);
		expect(result.status).toBe("failed");

		const response = json(result);
		expect(response.status).toBe(200);
		expect((await response.json()) as typeof result).toMatchObject({ status: "failed" });
	});
});
