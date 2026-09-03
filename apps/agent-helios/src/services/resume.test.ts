import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { HeliosParams } from "@aureline/shared-types";
import { heliosRuns } from "../db/schema";
import { createTestDb, insertRow } from "../repository/test-db";
import type { HeliosDb } from "../db/client";
import { fakeEnv as sharedEnv, GATEWAY_COST_USD } from "./test-env";
import { SAMPLE_DESIGN_SESSION_ID, sampleParamsFull } from "../fixtures/sample-params";
import {
	completeImageRun,
	completeTextRun,
	failRunningRuns,
	pruneCompletedRuns,
	startImageRun,
	startTextRun,
} from "../repository/do.repository";
import { resumeRun } from "./resume";

// Only `startImageRun` is mocked, and only so one test can make opening the
// image row fail. Every other call goes to the real implementation.
vi.mock("../repository/do.repository", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../repository/do.repository")>();
	return { ...actual, startImageRun: vi.fn(actual.startImageRun) };
});

type TestDb = HeliosDb;

const TEXT_MODEL = "@cf/openai/gpt-oss-120b";
const DESIGN_SESSION_ID = SAMPLE_DESIGN_SESSION_ID;
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

// The shared fixture rather than an inline copy, which had drifted back in.
const PARAMS: HeliosParams = sampleParamsFull;

/** base64 for the bytes [72, 101, 108, 108, 111] ("Hello") */
const BASE64 = "SGVsbG8=";

/**
 * A fake `Env` for the resume suite, from the shared definition.
 *
 * The local one this replaces built its own no-op D1 that answered every query
 * with nothing, so an export could not be asserted on at all. The shared fake's
 * `DB` really writes, and `d1` comes back so a test can read what landed.
 */
function fakeEnv(overrides: { imageError?: Error; maxResumeAttempts?: number } = {}) {
	const { env, run, patternsPut, d1 } = sharedEnv({
		image: overrides.imageError,
		maxResumeAttempts: overrides.maxResumeAttempts,
	});

	return { env, run, put: patternsPut, d1 };
}

/** Every model name the fake `AI` binding was called with, in order. */
function modelsCalled(run: ReturnType<typeof fakeEnv>["run"]): string[] {
	return run.mock.calls.map((call) => call[0]);
}

/**
 * The state a resume exists for, written through the same repository functions
 * the pipeline uses: the planner succeeded and settled its row, then the image
 * call failed.
 */
async function seedImageFailure(db: TestDb, pipelineId: string) {
	await startTextRun(db, {
		pipelineId,
		designSessionId: DESIGN_SESSION_ID,
		userPrompt: "art deco fan motif",
		modelMetadata: { model: TEXT_MODEL },
	});
	await completeTextRun(db, pipelineId, PARAMS, { model: TEXT_MODEL, usage: { neurons: 95 } }, 0.001);
	await startImageRun(db, {
		pipelineId,
		designSessionId: DESIGN_SESSION_ID,
		userPrompt: "art deco fan motif",
		plannerParams: PARAMS,
		modelMetadata: { model: IMAGE_MODEL, steps: 4 },
	});
	await failRunningRuns(db, pipelineId, null);
}

/** The rows of one invocation, keyed by modality. */
async function rowsOf(db: TestDb, pipelineId: string) {
	const rows = await db.select().from(heliosRuns);
	const mine = rows.filter((row) => row.pipelineId === pipelineId);

	return {
		all: mine,
		text: mine.find((row) => row.modality === "text"),
		image: mine.find((row) => row.modality === "image"),
	};
}

/** `model_metadata` reads back as `unknown`; every test wants it as an object. */
function metadata(row: { modelMetadata: unknown } | undefined): Record<string, unknown> {
	return (row?.modelMetadata ?? {}) as Record<string, unknown>;
}

describe("resumeRun", () => {
	let db: TestDb;

	beforeEach(async () => {
		db = createTestDb();
		// Drains any queued `...Once` value and restores the live delegate, so a
		// test that fails before consuming its queue cannot leak it into the next.
		vi.mocked(startImageRun).mockReset();
		await seedImageFailure(db, "original-1");
	});

	it("mints a new pipeline_id and reuses the stored params exactly", async () => {
		const { env } = fakeEnv();

		const outcome = await resumeRun(db, "original-1", env, "http://localhost");

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.result.pipeline_id).not.toBe("original-1");
		expect(outcome.result.status).toBe("completed");
		expect(outcome.result.params).toEqual(PARAMS);
		expect(outcome.result.image_url).toBe(`http://localhost/images/patterns/${outcome.result.pipeline_id}.jpg`);
		expect(outcome.result.cost_usd).toBe(GATEWAY_COST_USD);
	});

	it("inherits design_session_id from the run it resumes, rather than minting a new one", async () => {
		// A retry belongs to the design it is retrying. If a resume minted its own,
		// every failed-then-recovered design would split into two in D1, which is
		// precisely the tracing the column exists to provide (AGENTS.md §3).
		const { env } = fakeEnv();

		const outcome = await resumeRun(db, "original-1", env, "http://localhost");
		if (!outcome.ok) throw new Error("expected a run");

		expect(outcome.result.design_session_id).toBe(DESIGN_SESSION_ID);

		// On the rows too, not just in the response, since the rows are what any
		// later query reads.
		const { all } = await rowsOf(db, outcome.result.pipeline_id);
		expect(all.every((row) => row.designSessionId === DESIGN_SESSION_ID)).toBe(true);

		// And the original is untouched and still part of the same design, so the
		// two attempts group together while staying separately identifiable.
		const original = await rowsOf(db, "original-1");
		expect(original.all.every((row) => row.designSessionId === DESIGN_SESSION_ID)).toBe(true);
		expect(outcome.result.pipeline_id).not.toBe("original-1");
	});

	it("never calls the planner, which is the entire point of the route", async () => {
		const { env, run } = fakeEnv();

		await resumeRun(db, "original-1", env, "http://localhost");

		expect(modelsCalled(run)).toEqual([IMAGE_MODEL]);
	});

	it("writes two rows, the text one already settled with no cost and the planner marked skipped", async () => {
		const { env } = fakeEnv();

		const outcome = await resumeRun(db, "original-1", env, "http://localhost");
		if (!outcome.ok) throw new Error("expected a run");

		const { all, text, image } = await rowsOf(db, outcome.result.pipeline_id);
		expect(all).toHaveLength(2);

		// ADR-0001: one invocation is two rows. A resume that opened only an image
		// row would leave anything reading D1 with half a run.
		expect(text?.status).toBe("completed");
		expect(text?.plannerParams).toEqual(PARAMS);
		// Copying the original planner's cost here would bill the same call twice.
		expect(text?.costUsd).toBeNull();
		expect(metadata(text).planner_skipped).toBe(true);
		// The model that actually produced these params, not whatever KV holds now.
		expect(metadata(text).model).toBe(TEXT_MODEL);

		expect(image?.status).toBe("completed");
		expect(image?.imageR2Key).toBe(`patterns/${outcome.result.pipeline_id}.jpg`);
		expect(image?.costUsd).toBe(GATEWAY_COST_USD);
	});

	it("sends no reference image, and takes the gateway-routed path that still reports a cost", async () => {
		// Resume is unchanged by the reference-image work and has to stay that way.
		// The image is transient and was never persisted, so a resumed run has none
		// — which means it takes the JSON path, routes through the gateway, and
		// reports a real cost. A resume that somehow reached the multipart branch
		// would silently start reporting null costs for every retry.
		const { env, run } = fakeEnv();

		const outcome = await resumeRun(db, "original-1", env, "http://localhost");
		if (!outcome.ok) throw new Error("expected a run");

		const [model, input, options] = run.mock.calls[0] ?? [];
		expect(model).toBe(IMAGE_MODEL);
		expect(input).not.toHaveProperty("multipart");
		expect(options).toBeDefined();

		const { image } = await rowsOf(db, outcome.result.pipeline_id);
		expect(metadata(image).transport).toBe("json");
		expect(metadata(image).reference_image_sent).toBe(false);
		expect(image?.costUsd).toBe(GATEWAY_COST_USD);
	});

	it("records reference_image_sent false even when the original run had one", async () => {
		// The two flags disagree by design, and the disagreement is the record: the
		// text row's `had_reference_image` says the params were shaped by a picture,
		// the image row's `reference_image_sent` says this attempt's pixels were
		// not. Without both, "why does the retry look different" has no answer.
		await seedImageFailure(db, "had-image-1");
		await db
			.update(heliosRuns)
			.set({ modelMetadata: { model: TEXT_MODEL, had_reference_image: true } })
			.where(and(eq(heliosRuns.pipelineId, "had-image-1"), eq(heliosRuns.modality, "text")));
		const { env } = fakeEnv();

		const outcome = await resumeRun(db, "had-image-1", env, "http://localhost");
		if (!outcome.ok) throw new Error("expected a run");

		const { image } = await rowsOf(db, outcome.result.pipeline_id);
		expect(metadata(image).reference_image_sent).toBe(false);

		// And the original's own record is untouched.
		const original = await rowsOf(db, "had-image-1");
		expect(metadata(original.text).had_reference_image).toBe(true);
	});

	it("marks both rows with resumed_from and attempt, and neither row of an original", async () => {
		const { env } = fakeEnv();

		const outcome = await resumeRun(db, "original-1", env, "http://localhost");
		if (!outcome.ok) throw new Error("expected a run");

		// The image row is the one carrying cost_usd and image_r2_key, so it is what
		// every cost query reads. Marking only the text row leaves the real gap open.
		const resumed = await rowsOf(db, outcome.result.pipeline_id);
		for (const row of resumed.all) {
			expect(metadata(row).resumed_from).toBe("original-1");
			expect(metadata(row).attempt).toBe(2);
		}

		const original = await rowsOf(db, "original-1");
		for (const row of original.all) {
			expect(metadata(row).resumed_from).toBeUndefined();
			expect(metadata(row).attempt).toBeUndefined();
		}
	});

	it("leaves the original failed run exactly as it was", async () => {
		const { env } = fakeEnv();
		const before = await rowsOf(db, "original-1");

		await resumeRun(db, "original-1", env, "http://localhost");

		const after = await rowsOf(db, "original-1");
		expect(after.all).toEqual(before.all);
		expect(after.text?.status).toBe("completed");
		expect(after.image?.status).toBe("failed");
	});

	it("keeps the params and records the cost when the resumed image itself fails", async () => {
		// The model bills before the R2 save and the row update, so a failure after
		// the call must still report what it cost.
		const { env, put } = fakeEnv();
		put.mockRejectedValue(new Error("r2 unavailable"));

		const outcome = await resumeRun(db, "original-1", env, "http://localhost");
		if (!outcome.ok) throw new Error("expected a run, not a refusal");

		expect(outcome.result.status).toBe("failed");
		expect(outcome.result.params).toEqual(PARAMS);
		expect(outcome.result.image_url).toBeNull();
		expect(outcome.result.cost_usd).toBe(GATEWAY_COST_USD);
		expect(outcome.result.error).toMatch(/^image: /);

		const { text, image } = await rowsOf(db, outcome.result.pipeline_id);
		expect(text?.status).toBe("completed");
		expect(image?.status).toBe("failed");
		expect(image?.costUsd).toBe(GATEWAY_COST_USD);
	});

	it("still records a failed image row when opening that row is what failed", async () => {
		// The same hole runPipeline had. A resume that could not open its image row
		// would settle as a lone completed text row: a failure that reads as a
		// success and that pruning deletes like any other completed run.
		const { env } = fakeEnv();
		vi.mocked(startImageRun).mockRejectedValueOnce(new Error("storage hiccup"));

		const outcome = await resumeRun(db, "original-1", env, "http://localhost");
		if (!outcome.ok) throw new Error("expected a run, not a refusal");

		expect(outcome.result.status).toBe("failed");
		expect(outcome.result.error).toMatch(/^image: /);

		const { all, text, image } = await rowsOf(db, outcome.result.pipeline_id);
		expect(all).toHaveLength(2);
		expect(text?.status).toBe("completed");
		expect(image?.status).toBe("failed");
		// The resume marker still has to reach the image row, since that row is
		// what cost queries read.
		expect(metadata(image).resumed_from).toBe("original-1");
		expect(metadata(image).attempt).toBe(2);

		await pruneCompletedRuns(db, 0);
		expect((await rowsOf(db, outcome.result.pipeline_id)).all).toHaveLength(2);
	});

	it("stamps the original's id as the root on both rows", async () => {
		const { env } = fakeEnv();

		const outcome = await resumeRun(db, "original-1", env, "http://localhost");
		if (!outcome.ok) throw new Error("expected a run");

		const { all } = await rowsOf(db, outcome.result.pipeline_id);
		for (const row of all) {
			expect(metadata(row).root).toBe("original-1");
		}
	});

	it("keeps one root across a whole chain, however deep it goes", async () => {
		// `attempt` is depth and `resumed_from` is the immediate parent, so neither
		// answers "how much has this concept cost". `root` does, in one query.
		const failing = fakeEnv({ imageError: new Error("model unavailable") });
		const first = await resumeRun(db, "original-1", failing.env, "http://localhost");
		if (!first.ok) throw new Error("expected a run");

		const second = await resumeRun(db, first.result.pipeline_id, fakeEnv().env, "http://localhost");
		if (!second.ok) throw new Error("expected a run");

		const secondRows = await rowsOf(db, second.result.pipeline_id);
		for (const row of secondRows.all) {
			expect(metadata(row).root).toBe("original-1");
			expect(metadata(row).resumed_from).toBe(first.result.pipeline_id);
			expect(metadata(row).attempt).toBe(3);
		}
	});

	it("refuses once the brief has used up its resume attempts", async () => {
		// Two failed resumes at a limit of two, so the third must refuse. Without
		// this, a client looping on a failed run bills an image every time.
		for (let i = 0; i < 2; i++) {
			const { env } = fakeEnv({ imageError: new Error("model unavailable"), maxResumeAttempts: 2 });
			const outcome = await resumeRun(db, "original-1", env, "http://localhost");
			if (!outcome.ok) throw new Error(`resume ${i + 1} should have been allowed`);
			expect(outcome.result.status).toBe("failed");
		}

		const { env, run } = fakeEnv({ maxResumeAttempts: 2 });
		const refused = await resumeRun(db, "original-1", env, "http://localhost");

		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.reason).toMatch(/already been resumed 2 times, the limit is 2/);
		// The point of the guard: nothing was spent.
		expect(run).not.toHaveBeenCalled();
	});

	it("counts siblings, not just depth, so retrying the same run repeatedly is capped", async () => {
		// Every one of these resumes the same parent, so they all read attempt 2.
		// A cap on `attempt` would never fire; a cap on root does.
		for (let i = 0; i < 2; i++) {
			const { env } = fakeEnv({ imageError: new Error("model unavailable"), maxResumeAttempts: 2 });
			await resumeRun(db, "original-1", env, "http://localhost");
		}

		const attempts = (await db.select().from(heliosRuns))
			.filter((row) => row.modality === "image")
			.map((row) => (row.modelMetadata as { attempt?: number }).attempt);
		expect(attempts.filter((a) => a === 2)).toHaveLength(2);

		const refused = await resumeRun(db, "original-1", fakeEnv({ maxResumeAttempts: 2 }).env, "http://localhost");
		expect(refused.ok).toBe(false);
	});

	it("can itself be resumed, chaining attempt and pointing at the immediate parent", async () => {
		const failing = fakeEnv({ imageError: new Error("model unavailable") });
		const first = await resumeRun(db, "original-1", failing.env, "http://localhost");
		if (!first.ok) throw new Error("expected a run");
		expect(first.result.status).toBe("failed");

		const working = fakeEnv();
		const second = await resumeRun(db, first.result.pipeline_id, working.env, "http://localhost");
		if (!second.ok) throw new Error("expected a run");
		expect(second.result.status).toBe("completed");

		const secondRows = await rowsOf(db, second.result.pipeline_id);
		for (const row of secondRows.all) {
			expect(metadata(row).attempt).toBe(3);
			// The immediate parent, not the root. A chain of three reads back as one
			// brief, three charges, one pattern.
			expect(metadata(row).resumed_from).toBe(first.result.pipeline_id);
		}

		// All three runs stay inspectable.
		const everything = await db.select().from(heliosRuns);
		expect(new Set(everything.map((row) => row.pipelineId)).size).toBe(3);
	});
});

describe("resumeRun refusals", () => {
	let db: TestDb;

	beforeEach(() => {
		db = createTestDb();
	});

	/** A refusal must not have called the model or written anything. */
	async function expectRefusal(pipelineId: string, pattern: RegExp) {
		const { env, run } = fakeEnv();
		const before = (await db.select().from(heliosRuns)).length;

		const outcome = await resumeRun(db, pipelineId, env, "http://localhost");

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toMatch(pattern);
		expect(run).not.toHaveBeenCalled();
		expect(await db.select().from(heliosRuns)).toHaveLength(before);
	}

	it("refuses a run it cannot find", async () => {
		await expectRefusal("never-happened", /no run/i);
	});

	it("re-runs the whole pipeline when the run never produced params", async () => {
		// This used to refuse. Since Phase 2 a run can fail at classify or research
		// — before the planner is even reached — and those are exactly the failures
		// worth retrying, so it starts again from the top rather than sending the
		// caller away.
		await startTextRun(db, {
			pipelineId: "planner-failed",
			designSessionId: DESIGN_SESSION_ID,
			userPrompt: "a concept",
			modelMetadata: { model: TEXT_MODEL },
		});
		await failRunningRuns(db, "planner-failed", null);

		const { env } = fakeEnv();
		const outcome = await resumeRun(db, "planner-failed", env, "http://localhost");

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		expect(outcome.result.status).toBe("completed");
		// A new run of Helios, so a new pipeline id — but the same design.
		expect(outcome.result.pipeline_id).not.toBe("planner-failed");
		expect(outcome.result.design_session_id).toBe(DESIGN_SESSION_ID);
		// Params it did not have before, because the planner actually ran.
		expect(outcome.result.params).not.toBeNull();
	});

	it("re-runs from the classifier, not from the planner", async () => {
		// The distinction that makes this path different from the image-only
		// resume: there are no params to reuse, so every stage runs again.
		await startTextRun(db, {
			pipelineId: "classify-failed",
			designSessionId: DESIGN_SESSION_ID,
			userPrompt: "a concept",
			modelMetadata: { model: TEXT_MODEL },
		});
		await failRunningRuns(db, "classify-failed", null);

		const { env, run } = fakeEnv();
		await resumeRun(db, "classify-failed", env, "http://localhost");

		const models = run.mock.calls.map(([model]) => model);
		expect(models).toContain("@cf/meta/llama-4-scout-17b-16e-instruct");
		expect(models).toContain("@cf/openai/gpt-oss-120b");
	});

	it("counts a full re-run against the resume cap, like any other resume", async () => {
		// It spends a classify, a planner and an image call — more than the
		// image-only path, not less — so a cap that could not see it would be no
		// cap at all.
		await startTextRun(db, {
			pipelineId: "capped",
			designSessionId: DESIGN_SESSION_ID,
			userPrompt: "a concept",
			modelMetadata: { model: TEXT_MODEL, root: "capped" },
		});
		await failRunningRuns(db, "capped", null);
		// Three image rows already charged to this root, at the default cap of 3.
		for (const id of ["a", "b", "c"]) {
			await insertRow(db, { pipelineId: id, modality: "image", modelMetadata: { root: "capped" } });
		}

		await expectRefusal("capped", /already been resumed 3 times/i);
	});

	it("carries the lineage onto the re-run's rows, so the next resume can count it", async () => {
		await startTextRun(db, {
			pipelineId: "lineage",
			designSessionId: DESIGN_SESSION_ID,
			userPrompt: "a concept",
			modelMetadata: { model: TEXT_MODEL },
		});
		await failRunningRuns(db, "lineage", null);

		const { env } = fakeEnv();
		const outcome = await resumeRun(db, "lineage", env, "http://localhost");
		if (!outcome.ok) throw new Error("expected the re-run to be attempted");

		const rows = await db
			.select()
			.from(heliosRuns)
			.where(eq(heliosRuns.pipelineId, outcome.result.pipeline_id));

		for (const row of rows) {
			expect(row.modelMetadata).toMatchObject({ root: "lineage", resumed_from: "lineage", attempt: 2 });
		}
	});

	it("refuses a run with no text row at all, which is a different thing", async () => {
		// Separated from the failure above (AGENTS.md §7): one is an incomplete
		// record and resuming would build on state that was never written; the
		// other is a run worth retrying. They now get opposite answers.
		await insertRow(db, { pipelineId: "image-only", modality: "image", status: "failed" });

		await expectRefusal("image-only", /has no text row/i);
	});

	it("refuses a run that already has an image, because that would be a second charge", async () => {
		await seedImageFailure(db, "done-1");
		await completeImageRun(db, { pipelineId: "done-1", imageR2Key: "patterns/done-1.jpg", costUsd: 0.0009 });

		await expectRefusal("done-1", /already has an image/i);
	});

	it("refuses while the image is still running, so a concurrent invocation is not double charged", async () => {
		await startTextRun(db, {
			pipelineId: "in-flight",
			designSessionId: DESIGN_SESSION_ID,
			userPrompt: "a concept",
			modelMetadata: { model: TEXT_MODEL },
		});
		await completeTextRun(db, "in-flight", PARAMS, { model: TEXT_MODEL }, 0.001);
		await startImageRun(db, {
			pipelineId: "in-flight",
			designSessionId: DESIGN_SESSION_ID,
			userPrompt: "a concept",
			plannerParams: PARAMS,
			modelMetadata: { model: IMAGE_MODEL, steps: 4 },
		});

		await expectRefusal("in-flight", /still being generated/i);
	});

	it("refuses when the stored params no longer satisfy the schema", async () => {
		// Seeded as a whole resumable run, not just a text row: the params check
		// sits behind the missing-image-row guard, so a lone text row would be
		// refused for the wrong reason and this test would pass without ever
		// reaching the branch it names.
		await seedImageFailure(db, "stale-params");
		await db
			.update(heliosRuns)
			.set({ plannerParams: { motif_type: "fan" } })
			.where(and(eq(heliosRuns.pipelineId, "stale-params"), eq(heliosRuns.modality, "text")));

		await expectRefusal("stale-params", /no longer valid/i);
	});

	it("refuses a run whose image row was never written, rather than billing a new image", async () => {
		// ADR-0001 says an invocation is two rows. A lone completed text row means
		// a write was lost — `runImageStage`'s rescue insert is itself inside a
		// catch. Before this guard existed both status checks used `?.`, so
		// `undefined` matched neither and execution fell through into the image
		// call (AGENTS.md §7).
		await startTextRun(db, {
			pipelineId: "no-image-row",
			designSessionId: DESIGN_SESSION_ID,
			userPrompt: "a concept",
			modelMetadata: { model: TEXT_MODEL },
		});
		await completeTextRun(db, "no-image-row", PARAMS, { model: TEXT_MODEL }, 0.001);

		await expectRefusal("no-image-row", /no image row at all/i);
	});
});
