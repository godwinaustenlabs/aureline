import { describe, expect, it } from "vitest";
import { IrisParamsSchema } from "@aureline/shared-types";
import { planConcept } from "./planner";
import { colorizeMotif } from "./colorizer";
import { resolveConfig } from "../config";
import { sampleParamsFull } from "../fixtures/sample-params";
import { fakeEnv } from "./test-env";

/**
 * Contract tests for the two faked model stages.
 *
 * Both bodies are placeholders that iris-08 and iris-09 replace, so there is
 * nothing behaviourally interesting to assert yet. What is worth pinning is the
 * shape each one promises the pipeline, because that shape is what the real
 * implementations have to keep: these tests should still pass, unchanged, once
 * the fakes become real model calls.
 *
 * They also prove the fakes reach no model — `fakeEnv`'s `AI.run` throws.
 */

describe("planConcept", () => {
	it("returns params the validate stage accepts", async () => {
		const { env, run } = fakeEnv();
		const config = await resolveConfig(env);

		const planned = await planConcept("art deco paisley", env, config, "run-a");

		// Typed `unknown` on purpose — a real model cannot promise a shape — so the
		// pipeline's validate stage is what makes it trusted. That is the contract
		// worth asserting, not the fixture's identity.
		expect(IrisParamsSchema.safeParse(planned).success).toBe(true);
		expect(run).not.toHaveBeenCalled();
	});
});

describe("colorizeMotif", () => {
	it("returns bytes plus the dimensions and content type the pipeline records", async () => {
		const { env, run } = fakeEnv();
		const config = await resolveConfig(env);

		const image = await colorizeMotif("patterns/motif.jpg", sampleParamsFull, config, env, "run-a");

		expect(image.image).toBeInstanceOf(Uint8Array);
		expect(image.image.byteLength).toBeGreaterThan(0);
		expect(image.contentType).toBe("image/jpeg");
		// Width and height come back from the stage because model_metadata is their
		// only durable home — there is no column for them (iris-03 decision 9).
		expect(image.width).toBeGreaterThan(0);
		expect(image.height).toBeGreaterThan(0);
		expect(run).not.toHaveBeenCalled();
	});

	it("decodes to a real JPEG, not arbitrary bytes", async () => {
		const { env } = fakeEnv();
		const config = await resolveConfig(env);

		const image = await colorizeMotif("patterns/motif.jpg", sampleParamsFull, config, env, "run-a");

		// The fixture has to survive being written to R2, served back through
		// GET /images/*, and displayed in a browser. Random bytes would pass every
		// other assertion here and fail the one thing the fixture exists for.
		expect([...image.image.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
	});
});
