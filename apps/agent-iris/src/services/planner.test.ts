import { describe, expect, it, beforeEach, vi } from "vitest";
import { planConcept } from "./planner";
import { fakeEnv } from "./test-env";
import { resolveConfig } from "../config";
import { buildPlannerSystemPrompt } from "../prompts";
import { sampleParamsFull } from "../fixtures/sample-params";

/** A stand-in vision model id. Nothing calls a real one — the fake `AI` binding
 *  answers any planner id with the same structured reply. */
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

/**
 * The planner stage against a faked `AI` binding. No network, no model, no cost
 * (AGENTS.md §5).
 *
 * There is deliberately no `readGatewayCost` mock here: `planConcept` does not
 * read the cost. The pipeline does, on the line after this returns, because
 * `aiGatewayLogId` holds only the most recent routed call. The tests for that
 * live in `pipeline.test.ts`, where the behaviour actually is.
 */
describe("planConcept", () => {
	let env: Env;
	let config: Awaited<ReturnType<typeof resolveConfig>>;

	beforeEach(async () => {
		const fake = fakeEnv();
		env = fake.env;
		config = await resolveConfig(env);
	});

	it("returns a TextualModelOutput carrying data, usage, and model from the text call", async () => {
		const result = await planConcept(env, config, {
			concept: "deep navy and gold paisley",
			systemPrompt: buildPlannerSystemPrompt(),
			pipeline_id: "pipeline-test-1",
		});

		// `data` is typed `IrisParams`, so this reads it directly. The envelope is
		// the contract: the pipeline needs `model` and `usage` for the text row and
		// can only get them from here.
		expect(result.data).toEqual(sampleParamsFull);
		expect(result.model).toBe("@cf/openai/gpt-oss-120b");
		expect(result).toHaveProperty("usage");
	});

	it("propagates a schema validation failure from getTextualModelOutput", async () => {
		// One `fakeEnv()`, so the mock and the env handed to `planConcept` are the
		// same object. Building a second env to harvest its `run` and then writing
		// that over the first one's needs a cast to reach in, and a cast here would
		// be doing the opposite of what this test is for.
		const { env: failingEnv, run } = fakeEnv();

		// Valid JSON that is not `IrisParams`. `mockResolvedValue`, not `...Once`,
		// so every retry attempt also comes back wrong and the helper exhausts its
		// budget rather than succeeding on the second try.
		run.mockResolvedValue({
			choices: [{ message: { content: JSON.stringify({ completely: "wrong" }) } }],
			usage: { prompt_tokens: 100, completion_tokens: 50 },
		});

		await expect(
			planConcept(failingEnv, config, {
				concept: "some concept",
				systemPrompt: buildPlannerSystemPrompt(),
				pipeline_id: "pipeline-test-2",
			}),
		).rejects.toThrow("schema validation failed");
	});
});

/**
 * The reference image's one hop into a model call.
 *
 * Asserted on the request body handed to `ai.run`, not on `planConcept`'s
 * return value: the return value is identical either way, so a version of this
 * that dropped the image on the floor would pass every other test in the file.
 */
describe("planConcept with a reference image", () => {
	const REFERENCE = { bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" };

	/** The `ai.run` body for the planner call in this env. */
	function plannerBody(run: ReturnType<typeof vi.fn>): Record<string, unknown> {
		return run.mock.calls[0][1] as Record<string, unknown>;
	}

	it("sends a bare string prompt when no image is attached", async () => {
		// The regression promise. Every existing caller sends no image, and their
		// request body has to be exactly what it was.
		const { env: e, run } = fakeEnv();

		await planConcept(e, await resolveConfig(e), {
			concept: "deep navy and gold paisley",
			systemPrompt: buildPlannerSystemPrompt(),
			pipeline_id: "pipeline-no-image",
		});

		const messages = plannerBody(run).messages as { role: string; content: unknown }[];
		const user = messages.find((message) => message.role === "user");
		expect(typeof user?.content).toBe("string");
	});

	it("sends the image as a data URL content part when one is attached", async () => {
		const { env: e, run } = fakeEnv();

		await planConcept(e, await resolveConfig(e), {
			concept: "deep navy and gold paisley",
			systemPrompt: buildPlannerSystemPrompt(),
			pipeline_id: "pipeline-with-image",
			image: REFERENCE,
		});

		const messages = plannerBody(run).messages as { role: string; content: unknown }[];
		const user = messages.find((message) => message.role === "user");

		expect(user?.content).toEqual([
			{ type: "text", text: expect.stringContaining("deep navy and gold paisley") },
			{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==" } },
		]);
	});

	it("calls the vision model when one is configured", async () => {
		const { env: e, run } = fakeEnv({ visionPlannerModel: VISION_MODEL });

		await planConcept(e, await resolveConfig(e), {
			concept: "deep navy and gold paisley",
			systemPrompt: buildPlannerSystemPrompt(),
			pipeline_id: "pipeline-vision",
			image: REFERENCE,
		});

		expect(run.mock.calls[0][0]).toBe(VISION_MODEL);
	});

	it("calls the vision model even when no image is attached", async () => {
		// One model per deployment, not one per request. Branching on the request
		// would mean two sets of planner behaviour to tune and a class of bug that
		// only shows up once someone attaches an image (ADR-SHARED-0003).
		const { env: e, run } = fakeEnv({ visionPlannerModel: VISION_MODEL });

		await planConcept(e, await resolveConfig(e), {
			concept: "deep navy and gold paisley",
			systemPrompt: buildPlannerSystemPrompt(),
			pipeline_id: "pipeline-vision-no-image",
		});

		expect(run.mock.calls[0][0]).toBe(VISION_MODEL);
	});
});
