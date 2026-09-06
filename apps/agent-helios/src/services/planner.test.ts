import { describe, expect, it, vi } from "vitest";
import { planConcept } from "./planner";
import { fakeEnv } from "./test-env";
import { resolveConfig } from "../config";
import { buildPlannerSystemPrompt } from "../prompts";
import { sampleParamsFull } from "../fixtures/sample-params";

/** A stand-in vision model id. Nothing calls a real one — the fake `AI` binding
 *  answers either planner id with the same structured reply. */
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

/**
 * The planner stage against a faked `AI` binding. No network, no model, no cost
 * (AGENTS.md §5).
 *
 * Its subject is the request body handed to `ai.run`, not `planConcept`'s
 * return value — the return value is identical whether or not a reference image
 * was sent, so a version that dropped the image on the floor would satisfy
 * every assertion made anywhere else.
 */
describe("planConcept", () => {
	const REFERENCE = { bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" };

	/** The `ai.run` body for the planner call. */
	function plannerBody(run: ReturnType<typeof vi.fn>): Record<string, unknown> {
		return run.mock.calls[0][1] as Record<string, unknown>;
	}

	/** The user message out of that body. */
	function userContent(run: ReturnType<typeof vi.fn>): unknown {
		const messages = plannerBody(run).messages as { role: string; content: unknown }[];
		return messages.find((message) => message.role === "user")?.content;
	}

	it("returns the envelope the text row is built from", async () => {
		const { env, run } = fakeEnv();

		const result = await planConcept(env, await resolveConfig(env), {
			concept: "art deco fans for a hotel lobby cushion",
			systemPrompt: buildPlannerSystemPrompt(),
			pipeline_id: "pipeline-1",
		});

		expect(result.data).toEqual(sampleParamsFull);
		expect(result.model).toBe("@cf/openai/gpt-oss-120b");
		expect(result).toHaveProperty("usage");
		expect(run).toHaveBeenCalledOnce();
	});

	it("sends a bare string prompt when no image is attached", async () => {
		// The regression promise. Every existing caller sends no image, and their
		// request body has to be exactly what it was.
		const { env, run } = fakeEnv();

		await planConcept(env, await resolveConfig(env), {
			concept: "art deco fans",
			systemPrompt: buildPlannerSystemPrompt(),
			pipeline_id: "pipeline-no-image",
		});

		expect(typeof userContent(run)).toBe("string");
	});

	it("sends the image as a data URL content part when one is attached", async () => {
		const { env, run } = fakeEnv();

		await planConcept(env, await resolveConfig(env), {
			concept: "art deco fans",
			systemPrompt: buildPlannerSystemPrompt(),
			pipeline_id: "pipeline-with-image",
			image: REFERENCE,
		});

		expect(userContent(run)).toEqual([
			{ type: "text", text: expect.stringContaining("art deco fans") },
			{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==" } },
		]);
	});

	it("leaves the system prompt a bare string alongside an image", async () => {
		const { env, run } = fakeEnv();

		await planConcept(env, await resolveConfig(env), {
			concept: "art deco fans",
			systemPrompt: buildPlannerSystemPrompt(),
			pipeline_id: "pipeline-system",
			image: REFERENCE,
		});

		const messages = plannerBody(run).messages as { role: string; content: unknown }[];
		expect(typeof messages.find((message) => message.role === "system")?.content).toBe("string");
	});

	it("calls the vision model when one is configured, image or not", async () => {
		// One model per deployment, not one per request. Branching on the request
		// would mean two sets of planner behaviour to tune and a class of bug that
		// only shows up once someone attaches an image (ADR-SHARED-0003).
		const withImage = fakeEnv({ visionPlannerModel: VISION_MODEL });
		await planConcept(withImage.env, await resolveConfig(withImage.env), {
			concept: "art deco fans",
			systemPrompt: buildPlannerSystemPrompt(),
			pipeline_id: "pipeline-vision-image",
			image: REFERENCE,
		});
		expect(withImage.run.mock.calls[0][0]).toBe(VISION_MODEL);

		const without = fakeEnv({ visionPlannerModel: VISION_MODEL });
		await planConcept(without.env, await resolveConfig(without.env), {
			concept: "art deco fans",
			systemPrompt: buildPlannerSystemPrompt(),
			pipeline_id: "pipeline-vision-plain",
			image: undefined,
		});
		expect(without.run.mock.calls[0][0]).toBe(VISION_MODEL);
	});

	it("falls back to the text model when no vision model is configured", async () => {
		const { env, run } = fakeEnv();

		await planConcept(env, await resolveConfig(env), {
			concept: "art deco fans",
			systemPrompt: buildPlannerSystemPrompt(),
			pipeline_id: "pipeline-fallback",
			image: REFERENCE,
		});

		expect(run.mock.calls[0][0]).toBe("@cf/openai/gpt-oss-120b");
	});
});
