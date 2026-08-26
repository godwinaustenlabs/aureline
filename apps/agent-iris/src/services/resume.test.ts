import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resumeRun } from "./resume";
import { planConcept } from "./planner";
import { colorizeMotif } from "./colorizer";
import { irisRuns } from "../db/schema";
import { createTestDb, insertRow } from "../repository/test-db";
import { sampleParamsFull } from "../fixtures/sample-params";
import { fakeEnv } from "./test-env";

// Same delegate pattern `pipeline.test.ts` uses: the real implementation by
// default, so every test below exercises the real path, with individual tests
// forcing a failure where that is the thing being tested.
vi.mock("./planner", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./planner")>();
	return { ...actual, planConcept: vi.fn(actual.planConcept) };
});

vi.mock("./colorizer", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./colorizer")>();
	return { ...actual, colorizeMotif: vi.fn(actual.colorizeMotif) };
});

const ORIGIN = "http://localhost:8787";
const PARENT = "original-run-id";
const DESIGN = "design-session-abc";
const CONCEPT = "art deco paisley in deep jewel tones";
const MOTIF = "patterns/fake.jpg";

type Db = ReturnType<typeof createTestDb>;

/**
 * A run that failed at the image stage: the one state `/resume` acts on.
 *
 * Built whole through `insertRow` rather than a partial plus a cast, because
 * the shape is exactly what these tests are checking (AGENTS.md §5).
 */
async function seedResumableRun(
	db: Db,
	overrides: {
		pipelineId?: string;
		textStatus?: "running" | "completed" | "failed";
		plannerParams?: unknown;
		textMetadata?: Record<string, unknown>;
		imageMetadata?: Record<string, unknown>;
		imageStatus?: "running" | "completed" | "failed";
		omitImageRow?: boolean;
		motifRef?: string;
	} = {},
) {
	const pipelineId = overrides.pipelineId ?? PARENT;

	await insertRow(db, {
		pipelineId,
		modality: "text",
		status: overrides.textStatus ?? "completed",
		designSessionId: DESIGN,
		userPrompt: CONCEPT,
		motifRef: overrides.motifRef ?? MOTIF,
		plannerParams: overrides.plannerParams ?? sampleParamsFull,
		modelMetadata: overrides.textMetadata ?? { model: "@cf/openai/gpt-oss-120b" },
	});

	if (!overrides.omitImageRow) {
		await insertRow(db, {
			pipelineId,
			modality: "image",
			status: overrides.imageStatus ?? "failed",
			designSessionId: DESIGN,
			userPrompt: CONCEPT,
			motifRef: overrides.motifRef ?? MOTIF,
			plannerParams: overrides.plannerParams ?? sampleParamsFull,
			modelMetadata: overrides.imageMetadata ?? { model: "@cf/black-forest-labs/flux-2-klein-9b" },
		});
	}

	return pipelineId;
}

async function allRows(db: Db) {
	return db.select().from(irisRuns);
}

async function rowsFor(db: Db, pipelineId: string) {
	return db.select().from(irisRuns).where(eq(irisRuns.pipelineId, pipelineId));
}

/**
 * Marks a successful resume's image row `failed` so the chain can continue.
 *
 * The image row only. Failing the whole run would fail the text row too, and
 * `resumeRun` then refuses it for having no params rather than for the cap,
 * which is a green test proving the wrong thing.
 */
async function failImageRowOf(db: Db, pipelineId: string) {
	await db
		.update(irisRuns)
		.set({ status: "failed" })
		.where(and(eq(irisRuns.pipelineId, pipelineId), eq(irisRuns.modality, "image")));
}

describe("resumeRun refusals", () => {
	let db: Db;

	beforeEach(() => {
		db = createTestDb();
		vi.mocked(planConcept).mockReset();
		vi.mocked(colorizeMotif).mockReset();
	});

	it("refuses a run that is not in this session, naming the id", async () => {
		const { env, run } = fakeEnv();

		const outcome = await resumeRun(db, "nope", env, ORIGIN);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe("no run nope in this session");
		expect(run).not.toHaveBeenCalled();
		expect(await allRows(db)).toHaveLength(0);
	});

	it("refuses when the planner never succeeded, so there are no params to reuse", async () => {
		const { env, run } = fakeEnv();
		await seedResumableRun(db, { textStatus: "failed" });

		const outcome = await resumeRun(db, PARENT, env, ORIGIN);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe(
			"the planner never succeeded for this run, so there are no params to reuse. Send a new POST /generate",
		);
		expect(run).not.toHaveBeenCalled();
	});

	// The single most expensive failure available in this codebase. Helios's
	// guards read `imageRow?.status`, so a missing row matches neither branch and
	// falls through into generating another image.
	it("refuses a run whose image row is missing entirely, rather than generating one", async () => {
		const { env, run } = fakeEnv();
		await seedResumableRun(db, { omitImageRow: true });

		const before = await allRows(db);
		const outcome = await resumeRun(db, PARENT, env, ORIGIN);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toContain("this run has no image row");
		// The assertion this test exists for. A guard placed after the model call
		// refuses and still bills.
		expect(run).not.toHaveBeenCalled();
		expect(await allRows(db)).toHaveLength(before.length);
	});

	it("refuses a run that already has an image, rather than charging for a second", async () => {
		const { env, run } = fakeEnv();
		await seedResumableRun(db, { imageStatus: "completed" });

		const outcome = await resumeRun(db, PARENT, env, ORIGIN);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe(
			"this run already has an image, and resuming would generate and charge for a second one",
		);
		expect(run).not.toHaveBeenCalled();
	});

	it("refuses a run whose image is still being generated", async () => {
		const { env, run } = fakeEnv();
		await seedResumableRun(db, { imageStatus: "running" });

		const outcome = await resumeRun(db, PARENT, env, ORIGIN);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe(
			"this run's image is still being generated. Wait for it to settle before resuming",
		);
		expect(run).not.toHaveBeenCalled();
	});

	// "Present but not the value I expected" is a different situation from
	// "absent" and gets a different answer (AGENTS.md §7). Without this branch an
	// unrecognised status falls through the three checks above and generates.
	it("refuses a corrupted image row whose status is not one the table can hold", async () => {
		const { env, run } = fakeEnv();
		await seedResumableRun(db);
		// Written past the enum on purpose: this is what a corrupted row looks
		// like, and the column is a plain TEXT with no CHECK constraint.
		await db
			.update(irisRuns)
			.set({ status: "completd" as (typeof irisRuns.$inferSelect)["status"] })
			.where(eq(irisRuns.modality, "image"));

		const outcome = await resumeRun(db, PARENT, env, ORIGIN);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toContain("corrupted");
		expect(outcome.reason).toContain("completd");
		expect(run).not.toHaveBeenCalled();
	});

	it("refuses when the stored params no longer validate, naming the field", async () => {
		const { env, run } = fakeEnv();
		await seedResumableRun(db, { plannerParams: { primary_color: "not-a-colour-we-know" } });

		const outcome = await resumeRun(db, PARENT, env, ORIGIN);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toContain("the stored params are no longer valid:");
		expect(run).not.toHaveBeenCalled();
	});

	it("refuses once the cap is reached, naming the actual count and the actual limit", async () => {
		const { env, run } = fakeEnv({ maxResumeAttempts: "2" });
		await seedResumableRun(db);
		// Two resumes already spent against this root.
		for (const attempt of [2, 3]) {
			await insertRow(db, {
				pipelineId: `resume-${attempt}`,
				modality: "image",
				status: "failed",
				designSessionId: DESIGN,
				modelMetadata: { root: PARENT, resumed_from: PARENT, attempt },
			});
		}

		const outcome = await resumeRun(db, PARENT, env, ORIGIN);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe(
			"this brief has already been resumed 2 times, the limit is 2. Send a new POST /generate if it is still worth pursuing",
		);
		expect(run).not.toHaveBeenCalled();
	});

	it("refuses when the motif can no longer be read, before opening any row", async () => {
		const { env, run, patternsGet } = fakeEnv();
		await seedResumableRun(db);
		patternsGet.mockResolvedValueOnce(null);

		const before = await allRows(db);
		const outcome = await resumeRun(db, PARENT, env, ORIGIN);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toContain("the motif for this run can no longer be read:");
		expect(run).not.toHaveBeenCalled();
		// The point of pre-checking rather than letting runImageStage throw: a
		// refusal never became an invocation, so it writes no rows.
		expect(await allRows(db)).toHaveLength(before.length);
	});

	it("writes no rows and never reaches the model on any refusal", async () => {
		// Every refusal in one sweep, so a future refusal added without this
		// discipline is caught by a test that already exists.
		const cases: Array<() => Promise<{ id: string; env: Env; run: ReturnType<typeof vi.fn> }>> = [
			async () => {
				const { env, run } = fakeEnv();
				return { id: "missing", env, run };
			},
			async () => {
				const { env, run } = fakeEnv();
				await seedResumableRun(db, { pipelineId: "a", textStatus: "failed" });
				return { id: "a", env, run };
			},
			async () => {
				const { env, run } = fakeEnv();
				await seedResumableRun(db, { pipelineId: "b", omitImageRow: true });
				return { id: "b", env, run };
			},
			async () => {
				const { env, run } = fakeEnv();
				await seedResumableRun(db, { pipelineId: "c", imageStatus: "completed" });
				return { id: "c", env, run };
			},
			async () => {
				const { env, run } = fakeEnv();
				await seedResumableRun(db, { pipelineId: "d", imageStatus: "running" });
				return { id: "d", env, run };
			},
			async () => {
				const { env, run } = fakeEnv();
				await seedResumableRun(db, { pipelineId: "e", plannerParams: { nope: true } });
				return { id: "e", env, run };
			},
		];

		for (const build of cases) {
			const { id, env, run } = await build();
			const before = (await allRows(db)).length;

			const outcome = await resumeRun(db, id, env, ORIGIN);

			expect(outcome.ok).toBe(false);
			expect(run).not.toHaveBeenCalled();
			expect(await allRows(db)).toHaveLength(before);
		}
	});
});

describe("resumeRun success", () => {
	let db: Db;

	beforeEach(() => {
		db = createTestDb();
		vi.mocked(planConcept).mockReset();
		vi.mocked(colorizeMotif).mockReset();
	});

	it("generates a new image under a fresh pipeline_id, leaving the original untouched", async () => {
		const { env } = fakeEnv();
		await seedResumableRun(db);

		const outcome = await resumeRun(db, PARENT, env, ORIGIN);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.result.status).toBe("completed");
		expect(outcome.result.pipeline_id).not.toBe(PARENT);
		expect(outcome.result.image_url).toBe(`${ORIGIN}/images/iris/${outcome.result.pipeline_id}.jpg`);
		expect(outcome.result.width).toBe(128);
		expect(outcome.result.height).toBe(128);
		expect(outcome.result.params).toEqual(sampleParamsFull);

		// The original failed run is left exactly as it was: that record is the
		// point.
		const original = await rowsFor(db, PARENT);
		expect(original).toHaveLength(2);
		expect(original.find((row) => row.modality === "image")?.status).toBe("failed");
	});

	it("never calls the planner, even when calling it would throw", async () => {
		const { env } = fakeEnv();
		await seedResumableRun(db);
		vi.mocked(planConcept).mockRejectedValue(new Error("the planner must not be reached on a resume"));

		const outcome = await resumeRun(db, PARENT, env, ORIGIN);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.result.status).toBe("completed");
		expect(planConcept).not.toHaveBeenCalled();
	});

	it("puts root, resumed_from and attempt on both rows of the resumed run", async () => {
		const { env } = fakeEnv();
		await seedResumableRun(db);

		const outcome = await resumeRun(db, PARENT, env, ORIGIN);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		const rows = await rowsFor(db, outcome.result.pipeline_id);
		expect(rows).toHaveLength(2);

		for (const row of rows) {
			const metadata = row.modelMetadata as { root?: string; resumed_from?: string; attempt?: number };
			// Both rows, not just the text row. The image row is the one carrying
			// cost_usd and image_r2_key, so it is the row every cost query reads.
			expect(metadata.root).toBe(PARENT);
			expect(metadata.resumed_from).toBe(PARENT);
			expect(metadata.attempt).toBe(2);
		}
	});

	it("inserts the resumed text row already completed, with a null cost and the parent's model", async () => {
		const { env } = fakeEnv();
		await seedResumableRun(db, { textMetadata: { model: "@cf/some/older-planner" } });

		const outcome = await resumeRun(db, PARENT, env, ORIGIN);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		const textRow = (await rowsFor(db, outcome.result.pipeline_id)).find((row) => row.modality === "text");
		expect(textRow?.status).toBe("completed");
		// Nothing was re-planned. A phantom planner cost here would bill the same
		// call twice across every cost report built on this table.
		expect(textRow?.costUsd).toBeNull();
		const metadata = textRow?.modelMetadata as { model?: string; planner_skipped?: boolean };
		// The model that actually produced these params, not the one currently
		// configured, which was never called for this row.
		expect(metadata.model).toBe("@cf/some/older-planner");
		expect(metadata.planner_skipped).toBe(true);
	});

	it("inherits the parent's design_session_id rather than minting one", async () => {
		const { env } = fakeEnv();
		await seedResumableRun(db);

		const outcome = await resumeRun(db, PARENT, env, ORIGIN);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		expect(outcome.result.design_session_id).toBe(DESIGN);
		for (const row of await rowsFor(db, outcome.result.pipeline_id)) {
			expect(row.designSessionId).toBe(DESIGN);
		}
	});

	it("settles as failed at 200 when the image call throws, keeping the params", async () => {
		const { env } = fakeEnv();
		await seedResumableRun(db);
		vi.mocked(colorizeMotif).mockRejectedValueOnce(new Error("flux said no"));

		const outcome = await resumeRun(db, PARENT, env, ORIGIN);

		// A run that happened and failed is not a refusal.
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.result.status).toBe("failed");
		expect(outcome.result.error).toBe("image: flux said no");
		// Kept, not nulled: a failed resume is itself resumable.
		expect(outcome.result.params).toEqual(sampleParamsFull);

		const rows = await rowsFor(db, outcome.result.pipeline_id);
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.modality === "image")?.status).toBe("failed");
	});
});

describe("the spend cap counts over root, not resumed_from", () => {
	let db: Db;

	beforeEach(() => {
		db = createTestDb();
		vi.mocked(colorizeMotif).mockReset();
	});

	// A cap that counts `resumed_from` passes any single-level test and is
	// unbounded: each resume becomes the parent of the next and each count
	// restarts at one. Only a chain catches it.
	it("refuses the third resume of a chain when the limit is two", async () => {
		const { env } = fakeEnv({ maxResumeAttempts: "2" });
		await seedResumableRun(db);

		const first = await resumeRun(db, PARENT, env, ORIGIN);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		await failImageRowOf(db, first.result.pipeline_id);

		const second = await resumeRun(db, first.result.pipeline_id, env, ORIGIN);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		await failImageRowOf(db, second.result.pipeline_id);

		// Both resumes carry the same root, inherited from the original, however
		// deep the chain goes.
		const secondImage = (await rowsFor(db, second.result.pipeline_id)).find((row) => row.modality === "image");
		const secondMetadata = secondImage?.modelMetadata as { root?: string; resumed_from?: string; attempt?: number };
		expect(secondMetadata.root).toBe(PARENT);
		expect(secondMetadata.resumed_from).toBe(first.result.pipeline_id);
		expect(secondMetadata.attempt).toBe(3);

		const third = await resumeRun(db, second.result.pipeline_id, env, ORIGIN);
		expect(third.ok).toBe(false);
		if (third.ok) return;
		expect(third.reason).toContain("already been resumed 2 times, the limit is 2");
	});

	// The cap is the backstop if a guard is ever wrong, so it has to hold when
	// the data it counts is malformed rather than well-formed.
	it("still refuses when a row in the chain has corrupted metadata", async () => {
		const { env, run } = fakeEnv({ maxResumeAttempts: "2" });
		await seedResumableRun(db);

		for (const [index, metadata] of [
			{ root: PARENT, resumed_from: PARENT, attempt: 2 },
			// Not the shape anything expects: `root` present, `attempt` a string.
			{ root: PARENT, resumed_from: null, attempt: "two" },
		].entries()) {
			await insertRow(db, {
				pipelineId: `chain-${index}`,
				modality: "image",
				status: "failed",
				designSessionId: DESIGN,
				modelMetadata: metadata,
			});
		}

		const outcome = await resumeRun(db, PARENT, env, ORIGIN);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toContain("already been resumed 2 times");
		expect(run).not.toHaveBeenCalled();
	});

	it("falls back to the parent's own id as root when the parent carries none", async () => {
		const { env } = fakeEnv();
		// A legacy row, written before `root` existed.
		await seedResumableRun(db, { textMetadata: { model: "@cf/openai/gpt-oss-120b" } });

		const outcome = await resumeRun(db, PARENT, env, ORIGIN);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		const image = (await rowsFor(db, outcome.result.pipeline_id)).find((row) => row.modality === "image");
		const metadata = image?.modelMetadata as { root?: string; attempt?: number };
		expect(metadata.root).toBe(PARENT);
		// An original is depth 1, so its first retry is 2.
		expect(metadata.attempt).toBe(2);
	});
});
