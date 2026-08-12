import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HeliosParams, HeliosRequest } from "@aureline/shared-types";
import { runPipeline } from "./pipeline";
import { planConcept } from "./planner";
import { startTextRun, failRunningRuns } from "../repository/do.repository";
import { heliosRuns } from "../db/schema";
import { createTestDb, insertRow } from "../repository/test-db";

// The planner and the storage writes are imported by pipeline.ts, so mocking
// these two modules (with a delegate that calls the real thing by default) is
// how a test injects a failure and `pipeline.ts` sees it. The delegate keeps
// every other test on the real implementation.
vi.mock("./planner", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./planner")>();
	return { ...actual, planConcept: vi.fn(actual.planConcept) };
});

vi.mock("../repository/do.repository", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../repository/do.repository")>();
	return {
		...actual,
		startTextRun: vi.fn(actual.startTextRun),
		failRunningRuns: vi.fn(actual.failRunningRuns),
	};
});

/** The runtime config vars `resolveConfig` falls back to when KV is empty. */
const VARS = {
	PLANNER_MODEL: "@cf/openai/gpt-oss-120b",
	IMAGE_MODEL: "@cf/black-forest-labs/flux-1-schnell",
	AI_GATEWAY_ID: "helios",
	MAX_RETRIES: "2",
	RETENTION_LIMIT: "5",
};

const ORIGIN = "http://localhost:8787";

/** base64 for the bytes [72, 101, 108, 108, 111] ("Hello"). */
const BASE64 = "SGVsbG8=";

/** A schema-valid params object the planner hands back on a successful run. */
const VALID_PARAMS: HeliosParams = {
	motif_type: "art deco paisley",
	repeat_type: "half-drop",
	scale: "medium",
	density: "balanced",
	line_weight: "medium",
	texture_technique: "hatching",
	contrast_level: "high",
	style: "traditional",
};

const REQ: HeliosRequest = { concept: "art deco paisley" };

/**
 * Fake `Env` for the whole pipeline. `AI.run` dispatches on model name: the
 * planner model returns a Chat-Completions envelope carrying `VALID_PARAMS`,
 * the image model a base64 image. Each can be overridden (or turned into a
 * throw) per test. Storage, R2 and D1 are stubbed; the D1 binding is made to
 * throw so `exportAndPrune`'s try/catch swallows it, matching ticket 07's
 * "a failed export does not fail the run".
 */
function fakeEnv(
	overrides: {
		planner?: unknown | Error;
		image?: unknown | Error;
		maxRetries?: number;
		patternsPut?: "ok" | "fail";
		aiGatewayLogId?: string | null;
	} = {},
) {
	const vars = {
		...VARS,
		...(overrides.maxRetries !== undefined ? { MAX_RETRIES: String(overrides.maxRetries) } : {}),
	};

	const run = vi.fn(async (model: string) => {
		if (model === vars.PLANNER_MODEL) {
			if (overrides.planner instanceof Error) throw overrides.planner;
			return (
				overrides.planner ?? { response: JSON.stringify(VALID_PARAMS), usage: { neurons: 102 } }
			);
		}
		if (overrides.image instanceof Error) throw overrides.image;
		return overrides.image ?? { image: BASE64 };
	});

	const getLog = vi.fn().mockResolvedValue({ cost: 0.0019008 });
	const gateway = vi.fn().mockReturnValue({ getLog });
	const aiGatewayLogId = overrides.aiGatewayLogId !== undefined ? overrides.aiGatewayLogId : "log-1";

	const patternsPut = vi.fn().mockResolvedValue({});
	if (overrides.patternsPut === "fail") patternsPut.mockRejectedValue(new Error("r2 down"));

	const env = {
		AI: { run, gateway, aiGatewayLogId },
		AI_GATEWAY_ID: vars.AI_GATEWAY_ID,
		// Empty KV → every value resolves from the vars above.
		CONFIG: { get: vi.fn().mockResolvedValue(new Map<string, string | null>()) },
		PATTERNS: { put: patternsPut, get: vi.fn() },
		// The D1 driver calls prepare only when a query actually runs, so this
		// throws inside exportAndPrune and is swallowed.
		DB: { prepare: () => { throw new Error("d1 unavailable in tests"); } },
		PLANNER_MODEL: vars.PLANNER_MODEL,
		IMAGE_MODEL: vars.IMAGE_MODEL,
		MAX_RETRIES: vars.MAX_RETRIES,
		RETENTION_LIMIT: vars.RETENTION_LIMIT,
	} as unknown as Env;

	return { env, run, gateway, getLog, patternsPut };
}

async function rowsFor(db: ReturnType<typeof createTestDb>, pInvocId: string) {
	return db.select().from(heliosRuns).where(eq(heliosRuns.pInvocId, pInvocId));
}

describe("runPipeline failure behaviour", () => {
	let db: ReturnType<typeof createTestDb>;

	beforeEach(() => {
		db = createTestDb();
	});

	it("completes a happy path with real params and a full image url", async () => {
		const { env } = fakeEnv();

		const result = await runPipeline(db as never, REQ, env, ORIGIN);

		expect(result.status).toBe("completed");
		expect(result.params).toEqual(VALID_PARAMS);
		expect(result.cost_usd).toBe(0.0019008);
		expect(result.image_url).toBe(`${ORIGIN}/images/patterns/${result.p_invoc_id}.jpg`);
		expect(result.error).toBeNull();

		const rows = await rowsFor(db, result.p_invoc_id);
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.modality === "text")?.status).toBe("completed");
		expect(rows.find((row) => row.modality === "image")?.status).toBe("completed");
	});

	it("records the image cost when the image billed and the R2 save then fails", async () => {
		const { env } = fakeEnv({ patternsPut: "fail" });

		const result = await runPipeline(db as never, REQ, env, ORIGIN);

		// The money left the account, so it is reported on the failure too.
		expect(result.status).toBe("failed");
		expect(result.params).toEqual(VALID_PARAMS);
		expect(result.image_url).toBeNull();
		expect(result.cost_usd).toBe(0.0019008);
		expect(result.error).toMatch(/^image:/);

		const rows = await rowsFor(db, result.p_invoc_id);
		expect(rows.find((row) => row.modality === "text")?.status).toBe("completed");
		const imageRow = rows.find((row) => row.modality === "image");
		expect(imageRow?.status).toBe("failed");
		expect(imageRow?.costUsd).toBe(0.0019008);
		expect(imageRow?.imageR2Key).toBeNull();
	});

	it("marks a planner failure as one failed text row and no image row", async () => {
		const { env } = fakeEnv({ planner: new Error("boom") });

		const result = await runPipeline(db as never, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");
		expect(result.params).toBeNull();
		expect(result.image_url).toBeNull();
		expect(result.cost_usd).toBeNull();
		expect(result.error).toMatch(/^planner:/);

		const rows = await rowsFor(db, result.p_invoc_id);
		expect(rows).toHaveLength(1);
		expect(rows[0].modality).toBe("text");
		expect(rows[0].status).toBe("failed");
		expect(rows[0].completedAt).not.toBeNull();
	});

	it("fails at validate when the planner returns a shape that fails the schema", async () => {
		vi.mocked(planConcept).mockResolvedValueOnce({
			data: { ...VALID_PARAMS, repeat_type: "not-a-real-repeat" } as never,
			usage: undefined,
			model: VARS.PLANNER_MODEL,
		});
		const { env } = fakeEnv();

		const result = await runPipeline(db as never, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");
		expect(result.params).toBeNull();
		expect(result.error).toMatch(/^validate:/);

		const rows = await rowsFor(db, result.p_invoc_id);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("failed");
	});

	it("keeps the paid planner params when only the image fails", async () => {
		const { env } = fakeEnv({ image: new Error("flux down") });

		const result = await runPipeline(db as never, REQ, env, ORIGIN);

		// The planner succeeded; its params must survive the image failure.
		expect(result.status).toBe("failed");
		expect(result.params).toEqual(VALID_PARAMS);
		expect(result.error).toMatch(/^image:/);
		// The image call threw before a cost could be read, so none is reported.
		expect(result.cost_usd).toBeNull();

		const rows = await rowsFor(db, result.p_invoc_id);
		const textRow = rows.find((row) => row.modality === "text");
		const imageRow = rows.find((row) => row.modality === "image");
		expect(textRow?.status).toBe("completed");
		expect(textRow?.plannerParams).toEqual(VALID_PARAMS);
		expect(imageRow?.status).toBe("failed");
	});

	it("returns a settled failed result when storage itself is unavailable", async () => {
		const { env } = fakeEnv();
		vi.mocked(startTextRun).mockRejectedValueOnce(new Error("storage down"));
		// The cleanup write breaks too, and must not escape as a throw.
		vi.mocked(failRunningRuns).mockRejectedValueOnce(new Error("cleanup down"));

		const result = await runPipeline(db as never, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/^persist:/);
	});

	it("leaves a concurrent invocation's running row alone", async () => {
		await insertRow(db, { pInvocId: "other-inflight", modality: "text", status: "running" });
		await insertRow(db, { pInvocId: "other-inflight", modality: "image", status: "running" });
		const { env } = fakeEnv({ planner: new Error("boom") });

		const result = await runPipeline(db as never, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");

		const other = await rowsFor(db, "other-inflight");
		expect(other).toHaveLength(2);
		expect(other.every((row) => row.status === "running")).toBe(true);
	});

	it("runs the planner exactly maxRetries times on a planner failure", async () => {
		const { env, run } = fakeEnv({ planner: new Error("boom"), maxRetries: 2 });

		await runPipeline(db as never, REQ, env, ORIGIN);

		expect(run.mock.calls.filter((call) => call[0] === VARS.PLANNER_MODEL)).toHaveLength(2);
	});

	it("honours a maxRetries of 3", async () => {
		const { env, run } = fakeEnv({ planner: new Error("boom"), maxRetries: 3 });

		await runPipeline(db as never, REQ, env, ORIGIN);

		expect(run.mock.calls.filter((call) => call[0] === VARS.PLANNER_MODEL)).toHaveLength(3);
	});

	it("calls the image model exactly once on an image failure", async () => {
		const { env, run } = fakeEnv({ image: new Error("flux down") });

		await runPipeline(db as never, REQ, env, ORIGIN);

		expect(run.mock.calls.filter((call) => call[0] === VARS.IMAGE_MODEL)).toHaveLength(1);
	});
});