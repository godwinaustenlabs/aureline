import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HeliosParams, HeliosRequest } from "@aureline/shared-types";
import { runPipeline } from "./pipeline";
import { planConcept } from "./planner";
import { startTextRun, failRunningRuns, startImageRun, pruneCompletedRuns } from "../repository/do.repository";
import { heliosRuns } from "../db/schema";
import { createTestDb, insertRow } from "../repository/test-db";
import { upsertPrompt } from "../repository/prompts.repository";
import { getD1Db } from "../db/client";
import { buildPlannerSystemPrompt } from "../prompts";
import { fakeEnv as sharedEnv } from "./test-env";
// The same fixture the shared fake planner returns, so an assertion on
// `result.params` is comparing against what the model actually said.
import { sampleParamsFull as VALID_PARAMS, SAMPLE_DESIGN_SESSION_ID } from "../fixtures/sample-params";

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
		startImageRun: vi.fn(actual.startImageRun),
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



const REQ: HeliosRequest = { concept: "art deco paisley", design_session_id: SAMPLE_DESIGN_SESSION_ID };

/**
 * Fake `Env` for the whole pipeline, from the shared definition.
 *
 * `throwingD1` is on by default here, deliberately: these tests assert that a
 * failed export does not fail the run (helios-sprint-1 ticket 07), and that is
 * only meaningful against a `DB` that actually breaks. The export-lands-in-D1
 * assertions pass `throwingD1: false` to get a database that really writes.
 */
function fakeEnv(
	overrides: {
		planner?: unknown | Error;
		image?: unknown | Error;
		maxRetries?: number;
		patternsPut?: "ok" | "fail";
		aiGatewayLogId?: string | null;
		throwingD1?: boolean;
	} = {},
) {
	return sharedEnv({ throwingD1: overrides.throwingD1 ?? true, ...overrides });
}

async function rowsFor(db: ReturnType<typeof createTestDb>, pipelineId: string) {
	return db.select().from(heliosRuns).where(eq(heliosRuns.pipelineId, pipelineId));
}

describe("runPipeline failure behaviour", () => {
	let db: ReturnType<typeof createTestDb>;

	beforeEach(() => {
		db = createTestDb();
		// These mocks carry live delegates from `vi.fn(actual.x)`, and several
		// tests queue a `...Once` value. `mockReset` drains that queue and puts
		// the delegate back, so a test that fails before consuming its queued
		// value cannot leak it into the next one. A blanket `clearMocks` would
		// leave the queue in place, which is the bug rather than the fix.
		vi.mocked(planConcept).mockReset();
		vi.mocked(startTextRun).mockReset();
		vi.mocked(failRunningRuns).mockReset();
		vi.mocked(startImageRun).mockReset();
	});

	it("completes a happy path with real params and a full image url", async () => {
		const { env } = fakeEnv();

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.status).toBe("completed");
		expect(result.params).toEqual(VALID_PARAMS);
		expect(result.cost_usd).toBe(0.0019008);
		expect(result.image_url).toBe(`${ORIGIN}/images/patterns/${result.pipeline_id}.jpg`);
		expect(result.error).toBeNull();

		const rows = await rowsFor(db, result.pipeline_id);
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.modality === "text")?.status).toBe("completed");
		expect(rows.find((row) => row.modality === "image")?.status).toBe("completed");
	});

	it("carries design_session_id from the request onto both rows and into the result", async () => {
		// The chain AGENTS.md §3 describes, end to end: the id arrives on the
		// request, lands on every row of the run, and comes back out so Iris and
		// Atlas can carry the same one forward. A column written but never read back
		// is how that chain breaks without anyone noticing.
		const { env } = fakeEnv();

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.design_session_id).toBe(SAMPLE_DESIGN_SESSION_ID);
		// Not the pipeline id, which is minted per run. Two different things.
		expect(result.design_session_id).not.toBe(result.pipeline_id);

		const rows = await rowsFor(db, result.pipeline_id);
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.designSessionId === SAMPLE_DESIGN_SESSION_ID)).toBe(true);
	});

	/**
	 * The whole point of the table: an edit lands on the very next request with no
	 * deploy.
	 *
	 * It asserts on what the **model was actually sent**, not on what the resolver
	 * returned. A prompt that resolves correctly and is then never passed along is
	 * precisely the bug this wiring could have, and a test of the resolver alone
	 * would pass straight through it.
	 */
	it("sends the stored planner prompt to the model and records that it came from the database", async () => {
		// A database that really writes: `throwingD1` defaults to true in this file.
		const { env, run, d1 } = fakeEnv({ throwingD1: false });
		const edited = "You are a textile pattern designer. Rewritten in the playground, and this wording ran.";
		await upsertPrompt(getD1Db(d1), { slot: "helios_planner", promptText: edited });

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.status).toBe("completed");

		// The planner is the first call on the binding; the image call follows it.
		const input = run.mock.calls[0]?.[1] as { messages: { role: string; content: string }[] };
		expect(input.messages.find((message) => message.role === "system")?.content).toBe(edited);

		const textRow = (await rowsFor(db, result.pipeline_id)).find((row) => row.modality === "text");
		const meta = textRow?.modelMetadata as Record<string, unknown>;
		expect(meta).toHaveProperty("prompt_source", "db");
		expect(meta.prompt_updated_at).toBeTruthy();
		// No id can describe a prompt that is editable at will, so none is claimed.
		expect(meta).toHaveProperty("prompt_version", null);
	});

	/** The rollout case: a real database, with nothing seeded into it yet. */
	it("falls back to the committed prompt, and says so, when the slot has no row", async () => {
		const { env, run } = fakeEnv({ throwingD1: false });

		const result = await runPipeline(db, REQ, env, ORIGIN);

		const input = run.mock.calls[0]?.[1] as { messages: { role: string; content: string }[] };
		expect(input.messages.find((message) => message.role === "system")?.content).toBe(buildPlannerSystemPrompt());

		const textRow = (await rowsFor(db, result.pipeline_id)).find((row) => row.modality === "text");
		const meta = textRow?.modelMetadata as Record<string, unknown>;
		expect(meta).toHaveProperty("prompt_source", "code");
		expect(meta).toHaveProperty("prompt_version", "helios-planner-v3");
		expect(meta).toHaveProperty("prompt_updated_at", null);
		expect(meta).toHaveProperty("had_reference_image", false);
	});

	it("records had_reference_image on the text row when one was attached", async () => {
		// The reference image is transient and is never stored, so this flag is
		// the only durable trace it existed. Without it, "why does this run look
		// different from that one" is unanswerable from the audit table — which
		// matters most after a `/resume`, since resume re-runs the image stage
		// from these stored params and never sees an image at all.
		const { env } = fakeEnv();
		const withImage: HeliosRequest = {
			...REQ,
			image: { bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" },
		};

		const result = await runPipeline(db, withImage, env, ORIGIN);

		expect(result.status).toBe("completed");
		const textRow = (await rowsFor(db, result.pipeline_id)).find((row) => row.modality === "text");
		expect(textRow?.modelMetadata as Record<string, unknown>).toHaveProperty(
			"had_reference_image",
			true,
		);
	});

	it("records the model the image call actually used, not the one config predicted", async () => {
		// The row is opened before the call, so its metadata starts as a guess. Once
		// the model depends on whether an image was attached, that guess is wrong
		// for exactly the runs this work is about — a row still naming
		// flux-1-schnell after a call to klein is the lying audit row ADR-0001
		// exists to prevent.
		const { env } = fakeEnv();
		const withImage: HeliosRequest = {
			...REQ,
			image: { bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" },
		};

		const result = await runPipeline(db, withImage, env, ORIGIN);

		expect(result.status).toBe("completed");
		const imageRow = (await rowsFor(db, result.pipeline_id)).find((row) => row.modality === "image");
		const meta = imageRow?.modelMetadata as Record<string, unknown>;
		expect(meta).toHaveProperty("model", "@cf/black-forest-labs/flux-2-klein-9b");
		expect(meta).toHaveProperty("transport", "multipart");
		expect(meta).toHaveProperty("reference_image_sent", true);
		// A PNG, so the dimensions could not be read. Null rather than absent: the
		// row says nobody measured, instead of implying a size.
		expect(meta).toHaveProperty("reference_dimensions", null);
		// No steps were sent on this path, so none is claimed.
		expect(meta).not.toHaveProperty("steps");
	});

	it("records the text-to-image model and its steps when no image was attached", async () => {
		const { env } = fakeEnv();

		const result = await runPipeline(db, REQ, env, ORIGIN);

		const imageRow = (await rowsFor(db, result.pipeline_id)).find((row) => row.modality === "image");
		const meta = imageRow?.modelMetadata as Record<string, unknown>;
		expect(meta).toHaveProperty("model", "@cf/black-forest-labs/flux-1-schnell");
		expect(meta).toHaveProperty("transport", "json");
		expect(meta).toHaveProperty("steps", 4);
		expect(meta).toHaveProperty("reference_image_sent", false);
	});

	/**
	 * A prompt is policy, not a dependency the engine cannot run without. Every
	 * other test in this file runs against `throwingD1`, so this is the default
	 * path here — worth asserting rather than leaving implied.
	 */
	it("still completes when the database the prompt lives in is unavailable", async () => {
		const { env, run } = fakeEnv();

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.status).toBe("completed");
		const input = run.mock.calls[0]?.[1] as { messages: { role: string; content: string }[] };
		expect(input.messages.find((message) => message.role === "system")?.content).toBe(buildPlannerSystemPrompt());
	});

	it("gives two runs of one design different pipeline ids and the same design id", async () => {
		// What makes "which attempt is the latest" answerable while still grouping
		// the attempts together.
		const { env } = fakeEnv();

		const first = await runPipeline(db, REQ, env, ORIGIN);
		const second = await runPipeline(db, REQ, env, ORIGIN);

		expect(first.pipeline_id).not.toBe(second.pipeline_id);
		expect(first.design_session_id).toBe(second.design_session_id);
	});

	it("records the planner's cost in dollars, not in neurons", async () => {
		// The text row used to hold the provider's neuron figure, 102 here, in a
		// column called cost_usd, so any query summing the column across both
		// modalities was out by four orders of magnitude.
		const { env } = fakeEnv();

		const result = await runPipeline(db, REQ, env, ORIGIN);

		const textRow = (await rowsFor(db, result.pipeline_id)).find((row) => row.modality === "text");
		expect(textRow?.costUsd).toBe(0.0019008);
		expect(textRow?.costUsd).not.toBe(102);
		// The neuron figure is not lost, it just belongs in usage rather than in a
		// column that claims to be dollars.
		expect((textRow?.modelMetadata as { usage?: { neurons?: number } }).usage?.neurons).toBe(102);
	});

	it("records the image cost when the image billed and the R2 save then fails", async () => {
		const { env } = fakeEnv({ patternsPut: "fail" });

		const result = await runPipeline(db, REQ, env, ORIGIN);

		// The money left the account, so it is reported on the failure too.
		expect(result.status).toBe("failed");
		expect(result.params).toEqual(VALID_PARAMS);
		expect(result.image_url).toBeNull();
		expect(result.cost_usd).toBe(0.0019008);
		expect(result.error).toMatch(/^image:/);

		const rows = await rowsFor(db, result.pipeline_id);
		expect(rows.find((row) => row.modality === "text")?.status).toBe("completed");
		const imageRow = rows.find((row) => row.modality === "image");
		expect(imageRow?.status).toBe("failed");
		expect(imageRow?.costUsd).toBe(0.0019008);
		expect(imageRow?.imageR2Key).toBeNull();
	});

	it("marks a planner failure as one failed text row and no image row", async () => {
		const { env } = fakeEnv({ planner: new Error("boom") });

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");
		expect(result.params).toBeNull();
		expect(result.image_url).toBeNull();
		expect(result.cost_usd).toBeNull();
		expect(result.error).toMatch(/^planner:/);

		const rows = await rowsFor(db, result.pipeline_id);
		expect(rows).toHaveLength(1);
		expect(rows[0].modality).toBe("text");
		expect(rows[0].status).toBe("failed");
		expect(rows[0].completedAt).not.toBeNull();
	});

	it("fails at the planner stage when the model returns a shape that fails the schema", async () => {
		// Fed in as the model's own reply rather than by stubbing `planConcept`
		// past its own validation. That is what a drifting model actually looks
		// like, and it exercises the real planner, the real parse and the real
		// retry budget instead of three stubs.
		//
		// This replaces a test that asserted `/^validate:/` by handing
		// `planConcept` a pre-parsed object behind an `as never`. The pipeline's
		// own `HeliosParamsSchema.parse` is still there and still worth having as
		// defence in depth, but it sits behind `getTextualModelOutput`, which
		// validates against the same schema and retries first — so nothing that
		// arrives through the model can reach it. Its rejection is covered as data
		// in `contract.test.ts` instead (AGENTS.md §5).
		const { env } = fakeEnv({
			planner: { response: JSON.stringify({ ...VALID_PARAMS, repeat_type: "not-a-real-repeat" }) },
		});

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");
		expect(result.params).toBeNull();
		expect(result.error).toMatch(/^planner:/);

		const rows = await rowsFor(db, result.pipeline_id);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("failed");
	});

	it("keeps the paid planner params when only the image fails", async () => {
		const { env } = fakeEnv({ image: new Error("flux down") });

		const result = await runPipeline(db, REQ, env, ORIGIN);

		// The planner succeeded; its params must survive the image failure.
		expect(result.status).toBe("failed");
		expect(result.params).toEqual(VALID_PARAMS);
		expect(result.error).toMatch(/^image:/);
		// The image call threw before a cost could be read, so none is reported.
		expect(result.cost_usd).toBeNull();

		const rows = await rowsFor(db, result.pipeline_id);
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

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/^persist:/);
	});

	it("leaves a concurrent invocation's running row alone", async () => {
		await insertRow(db, { pipelineId: "other-inflight", modality: "text", status: "running" });
		await insertRow(db, { pipelineId: "other-inflight", modality: "image", status: "running" });
		const { env } = fakeEnv({ planner: new Error("boom") });

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");

		const other = await rowsFor(db, "other-inflight");
		expect(other).toHaveLength(2);
		expect(other.every((row) => row.status === "running")).toBe(true);
	});

	it("runs the planner exactly maxRetries times on a planner failure", async () => {
		const { env, run } = fakeEnv({ planner: new Error("boom"), maxRetries: 2 });

		await runPipeline(db, REQ, env, ORIGIN);

		expect(run.mock.calls.filter((call) => call[0] === VARS.PLANNER_MODEL)).toHaveLength(2);
	});

	it("honours a maxRetries of 3", async () => {
		const { env, run } = fakeEnv({ planner: new Error("boom"), maxRetries: 3 });

		await runPipeline(db, REQ, env, ORIGIN);

		expect(run.mock.calls.filter((call) => call[0] === VARS.PLANNER_MODEL)).toHaveLength(3);
	});

	it("still records a failed image row when opening that row is what failed", async () => {
		// Without this, failRunningRuns has nothing to mark: the text row is already
		// completed and the image row does not exist. The invocation settles as a
		// lone completed text row, so D1 shows a failure as a success.
		const { env } = fakeEnv();
		vi.mocked(startImageRun).mockRejectedValueOnce(new Error("storage hiccup"));

		const result = await runPipeline(db, REQ, env, ORIGIN);

		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/^image:/);
		expect(result.params).toEqual(VALID_PARAMS);

		const rows = await rowsFor(db, result.pipeline_id);
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.modality === "text")?.status).toBe("completed");
		const imageRow = rows.find((row) => row.modality === "image");
		expect(imageRow?.status).toBe("failed");
		expect(imageRow?.completedAt).not.toBeNull();
		// The params are duplicated onto the image row like any other (ADR-0001),
		// so the failure is inspectable without a join.
		expect(imageRow?.plannerParams).toEqual(VALID_PARAMS);
	});

	it("does not let that run be pruned as if it had succeeded", async () => {
		const { env } = fakeEnv();
		vi.mocked(startImageRun).mockRejectedValueOnce(new Error("storage hiccup"));

		const result = await runPipeline(db, REQ, env, ORIGIN);

		// A limit of 0 prunes every fully completed run. This one has a failed row,
		// so it must survive. Before the failed row was recorded it was a single
		// completed text row, and this deleted it.
		await pruneCompletedRuns(db, 0);

		expect(await rowsFor(db, result.pipeline_id)).toHaveLength(2);
	});

	it("calls the image model exactly once on an image failure", async () => {
		const { env, run } = fakeEnv({ image: new Error("flux down") });

		await runPipeline(db, REQ, env, ORIGIN);

		expect(run.mock.calls.filter((call) => call[0] === VARS.IMAGE_MODEL)).toHaveLength(1);
	});
});