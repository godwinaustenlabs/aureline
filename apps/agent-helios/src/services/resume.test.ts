import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { HeliosParams } from "@aureline/shared-types";
import { heliosRuns } from "../db/schema";
import { createTestDb } from "../repository/test-db";
import {
	completeImageRun,
	completeTextRun,
	failRunningRuns,
	startImageRun,
	startTextRun,
} from "../repository/do.repository";
import { resumeRun } from "./resume";

type TestDb = ReturnType<typeof createTestDb>;

const TEXT_MODEL = "@cf/openai/gpt-oss-120b";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

const PARAMS: HeliosParams = {
	motif_type: "art deco fan",
	repeat_type: "half-drop",
	scale: "medium",
	density: "balanced",
	line_weight: "medium",
	texture_technique: "hatching",
	contrast_level: "high",
	style: "traditional",
};

/** base64 for the bytes [72, 101, 108, 108, 111] ("Hello") */
const BASE64 = "SGVsbG8=";

/**
 * Enough of a D1 binding for `exportAndPrune` to run without touching a real
 * database. What export actually writes is ticket 07's suite; here it only has
 * to not throw and not fill the output with swallowed-error noise.
 */
function fakeD1(): D1Database {
	const statement = {
		bind: () => statement,
		all: async () => ({ results: [], success: true, meta: {} }),
		run: async () => ({ results: [], success: true, meta: {} }),
		first: async () => null,
		raw: async () => [],
	};

	return { prepare: () => statement, batch: async () => [] } as unknown as D1Database;
}

/**
 * A fake `Env` covering everything `resumeRun` reaches: KV for the config, the
 * `AI` binding and its gateway log, R2 and D1. No Worker runtime and no model
 * call, so the suite costs nothing.
 *
 * Same shape as `imageGenerator.test.ts`'s helper, widened because resume
 * touches storage as well as the model.
 */
function fakeEnv(overrides: { imageError?: Error } = {}) {
	const run = vi.fn(async (_model: string) => {
		if (overrides.imageError) throw overrides.imageError;
		return { image: BASE64 };
	});

	const getLog = vi.fn().mockResolvedValue({ cost: 0.0009 });
	const put = vi.fn().mockResolvedValue(undefined);

	const env = {
		AI: { run, gateway: () => ({ getLog }), aiGatewayLogId: "log-1" },
		AI_GATEWAY_ID: "helios",
		PATTERNS: { put },
		DB: fakeD1(),
		CONFIG: {
			get: async () =>
				new Map([
					["text_model", TEXT_MODEL],
					["image_model", IMAGE_MODEL],
					["max_retries", "2"],
					["retention_limit", "5"],
				]),
		},
	} as unknown as Env;

	return { env, run, put };
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
async function seedImageFailure(db: TestDb, pInvocId: string) {
	await startTextRun(db as never, pInvocId, "art deco fan motif", { model: TEXT_MODEL });
	await completeTextRun(db as never, pInvocId, PARAMS, { model: TEXT_MODEL, usage: { neurons: 95 } }, 0.001);
	await startImageRun(db as never, pInvocId, "art deco fan motif", PARAMS, { model: IMAGE_MODEL, steps: 4 });
	await failRunningRuns(db as never, pInvocId, null);
}

/** The rows of one invocation, keyed by modality. */
async function rowsOf(db: TestDb, pInvocId: string) {
	const rows = await db.select().from(heliosRuns);
	const mine = rows.filter((row) => row.pInvocId === pInvocId);

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
		await seedImageFailure(db, "original-1");
	});

	it("mints a new p_invoc_id and reuses the stored params exactly", async () => {
		const { env } = fakeEnv();

		const outcome = await resumeRun(db as never, "original-1", env, "http://localhost");

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.result.p_invoc_id).not.toBe("original-1");
		expect(outcome.result.status).toBe("completed");
		expect(outcome.result.params).toEqual(PARAMS);
		expect(outcome.result.image_url).toBe(`http://localhost/images/patterns/${outcome.result.p_invoc_id}.jpg`);
		expect(outcome.result.cost_usd).toBe(0.0009);
	});

	it("never calls the planner, which is the entire point of the route", async () => {
		const { env, run } = fakeEnv();

		await resumeRun(db as never, "original-1", env, "http://localhost");

		expect(modelsCalled(run)).toEqual([IMAGE_MODEL]);
	});

	it("writes two rows, the text one already settled with no cost and the planner marked skipped", async () => {
		const { env } = fakeEnv();

		const outcome = await resumeRun(db as never, "original-1", env, "http://localhost");
		if (!outcome.ok) throw new Error("expected a run");

		const { all, text, image } = await rowsOf(db, outcome.result.p_invoc_id);
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
		expect(image?.imageR2Key).toBe(`patterns/${outcome.result.p_invoc_id}.jpg`);
		expect(image?.costUsd).toBe(0.0009);
	});

	it("marks both rows with resumed_from and attempt, and neither row of an original", async () => {
		const { env } = fakeEnv();

		const outcome = await resumeRun(db as never, "original-1", env, "http://localhost");
		if (!outcome.ok) throw new Error("expected a run");

		// The image row is the one carrying cost_usd and image_r2_key, so it is what
		// every cost query reads. Marking only the text row leaves the real gap open.
		const resumed = await rowsOf(db, outcome.result.p_invoc_id);
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

		await resumeRun(db as never, "original-1", env, "http://localhost");

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

		const outcome = await resumeRun(db as never, "original-1", env, "http://localhost");
		if (!outcome.ok) throw new Error("expected a run, not a refusal");

		expect(outcome.result.status).toBe("failed");
		expect(outcome.result.params).toEqual(PARAMS);
		expect(outcome.result.image_url).toBeNull();
		expect(outcome.result.cost_usd).toBe(0.0009);
		expect(outcome.result.error).toMatch(/^image: /);

		const { text, image } = await rowsOf(db, outcome.result.p_invoc_id);
		expect(text?.status).toBe("completed");
		expect(image?.status).toBe("failed");
		expect(image?.costUsd).toBe(0.0009);
	});

	it("can itself be resumed, chaining attempt and pointing at the immediate parent", async () => {
		const failing = fakeEnv({ imageError: new Error("model unavailable") });
		const first = await resumeRun(db as never, "original-1", failing.env, "http://localhost");
		if (!first.ok) throw new Error("expected a run");
		expect(first.result.status).toBe("failed");

		const working = fakeEnv();
		const second = await resumeRun(db as never, first.result.p_invoc_id, working.env, "http://localhost");
		if (!second.ok) throw new Error("expected a run");
		expect(second.result.status).toBe("completed");

		const secondRows = await rowsOf(db, second.result.p_invoc_id);
		for (const row of secondRows.all) {
			expect(metadata(row).attempt).toBe(3);
			// The immediate parent, not the root. A chain of three reads back as one
			// brief, three charges, one pattern.
			expect(metadata(row).resumed_from).toBe(first.result.p_invoc_id);
		}

		// All three runs stay inspectable.
		const everything = await db.select().from(heliosRuns);
		expect(new Set(everything.map((row) => row.pInvocId)).size).toBe(3);
	});
});

describe("resumeRun refusals", () => {
	let db: TestDb;

	beforeEach(() => {
		db = createTestDb();
	});

	/** A refusal must not have called the model or written anything. */
	async function expectRefusal(pInvocId: string, pattern: RegExp) {
		const { env, run } = fakeEnv();
		const before = (await db.select().from(heliosRuns)).length;

		const outcome = await resumeRun(db as never, pInvocId, env, "http://localhost");

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toMatch(pattern);
		expect(run).not.toHaveBeenCalled();
		expect(await db.select().from(heliosRuns)).toHaveLength(before);
	}

	it("refuses a run it cannot find", async () => {
		await expectRefusal("never-happened", /no run/i);
	});

	it("refuses when the planner never succeeded, since there are no params to reuse", async () => {
		await startTextRun(db as never, "planner-failed", "a concept", { model: TEXT_MODEL });
		await failRunningRuns(db as never, "planner-failed", null);

		await expectRefusal("planner-failed", /planner never succeeded/i);
	});

	it("refuses a run that already has an image, because that would be a second charge", async () => {
		await seedImageFailure(db, "done-1");
		await completeImageRun(db as never, "done-1", "patterns/done-1.jpg", 0.0009);

		await expectRefusal("done-1", /already has an image/i);
	});

	it("refuses while the image is still running, so a concurrent invocation is not double charged", async () => {
		await startTextRun(db as never, "in-flight", "a concept", { model: TEXT_MODEL });
		await completeTextRun(db as never, "in-flight", PARAMS, { model: TEXT_MODEL }, 0.001);
		await startImageRun(db as never, "in-flight", "a concept", PARAMS, { model: IMAGE_MODEL, steps: 4 });

		await expectRefusal("in-flight", /still being generated/i);
	});

	it("refuses when the stored params no longer satisfy the schema", async () => {
		await startTextRun(db as never, "stale-params", "a concept", { model: TEXT_MODEL });
		await db
			.update(heliosRuns)
			.set({ status: "completed", plannerParams: { motif_type: "fan" } })
			.where(eq(heliosRuns.pInvocId, "stale-params"));

		await expectRefusal("stale-params", /no longer valid/i);
	});
});
