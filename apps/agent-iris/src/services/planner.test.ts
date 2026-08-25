import { describe, expect, it, vi, beforeEach } from "vitest";
import { planConcept } from "./planner";
import { fakeEnv } from "./test-env";
import { resolveConfig } from "../config";
import { sampleParamsFull } from "../fixtures/sample-params";

vi.mock("./gatewayCost", () => ({
	readGatewayCost: vi.fn().mockResolvedValue(null),
}));

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

		expect(result).toHaveProperty("data");
		expect(result).toHaveProperty("model");
		expect(result).toHaveProperty("usage");
		expect((result as { data: unknown }).data).toEqual(sampleParamsFull);
	});

	it("propagates a schema validation failure from getTextualModelOutput", async () => {
		const { run } = fakeEnv();
		// Return a valid JSON object that does NOT match IrisParamsSchema.
		// Use mockResolvedValue (not Once) so every retry attempt also returns
		// wrong data, guaranteeing the function exhausts all retries.
		run.mockResolvedValue({
			choices: [{ message: { content: JSON.stringify({ completely: "wrong" }) } }],
			usage: { prompt_tokens: 100, completion_tokens: 50 },
		});
		(env as unknown as { AI: { run: typeof run } }).AI.run = run;

		await expect(
			planConcept("some concept", env, config, "pipeline-test-2"),
		).rejects.toThrow("schema validation failed");
	});

	it("still completes when readGatewayCost returns null (decision 5)", async () => {
		// readGatewayCost is already mocked to return null in the module mock.
		const result = await planConcept("concept", env, config, "pipeline-test-3");

		expect(result).toHaveProperty("data");
		expect((result as { data: unknown }).data).toEqual(sampleParamsFull);
	});
});
