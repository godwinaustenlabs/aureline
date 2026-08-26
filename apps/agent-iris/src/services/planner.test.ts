import { describe, expect, it, beforeEach } from "vitest";
import { planConcept } from "./planner";
import { fakeEnv } from "./test-env";
import { resolveConfig } from "../config";
import { sampleParamsFull } from "../fixtures/sample-params";

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
		const result = await planConcept("deep navy and gold paisley", env, config, "pipeline-test-1");

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

		await expect(planConcept("some concept", failingEnv, config, "pipeline-test-2")).rejects.toThrow(
			"schema validation failed",
		);
	});
});
