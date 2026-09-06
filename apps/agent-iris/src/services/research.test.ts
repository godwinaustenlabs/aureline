import { describe, it, expect, beforeEach, vi } from "vitest";
import { runResearch } from "./research";
import { fakeEnv } from "./test-env";
import { resolveConfig } from "../config";
import { buildResearchSystemPrompt } from "../prompts";

vi.mock("@aureline/shared-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@aureline/shared-utils")>();
	return {
		...actual,
		runToolLoop: vi.fn(),
	};
});

import { runToolLoop } from "@aureline/shared-utils";

/**
 * The research stage against a faked AI and AI_SEARCH binding. No network,
 * no model, no cost (AGENTS §5).
 */
describe("runResearch", () => {
	let env: Env;
	let config: Awaited<ReturnType<typeof resolveConfig>>;

	beforeEach(async () => {
		const fake = fakeEnv();
		env = fake.env;
		config = await resolveConfig({
			...env,
			RESEARCH_MODEL: "@cf/openai/gpt-oss-120b",
		} as unknown as Env);
		vi.mocked(runToolLoop).mockReset();
	});

	it("returns context and metadata when search returns chunks", async () => {
		vi.mocked(runToolLoop).mockResolvedValueOnce({
			context: "Silk is a natural fibre...",
			chunks: [{ key: "silk-guide.md", score: 0.85, chars: 24 }],
			queries: ["silk colour conventions"],
			iterations: 1,
			quality: "ok",
		});

		const result = await runResearch(env, config, {
			concept: "silk paisley pattern",
			classification: { mode: "tile" },
			systemPrompt: buildResearchSystemPrompt(),
			pipeline_id: "pipeline-research-1",
		});

		expect(result.context).toBe("Silk is a natural fibre...");
		expect(result.metadata.enabled).toBe(true);
		expect(result.metadata.queries).toEqual(["silk colour conventions"]);
		expect(result.metadata.chunks).toEqual([
			{ key: "silk-guide.md", score: 0.85, chars: 24 },
		]);
		expect(result.metadata.instance).toBe("iris-kb");
	});

	it("returns null context when search returns no chunks", async () => {
		vi.mocked(runToolLoop).mockResolvedValueOnce({
			context: null,
			chunks: [],
			queries: [],
			iterations: 1,
			quality: "none",
		});

		const result = await runResearch(env, config, {
			concept: "nonexistent textile concept",
			classification: { mode: "tile" },
			systemPrompt: buildResearchSystemPrompt(),
			pipeline_id: "pipeline-research-2",
		});

		expect(result.context).toBeNull();
		expect(result.metadata.enabled).toBe(true);
		expect(result.metadata.chunks).toEqual([]);
	});

	it("returns skipped metadata when research model is empty", async () => {
		const skippedConfig = await resolveConfig({
			...env,
			RESEARCH_MODEL: "",
		} as unknown as Env);

		const result = await runResearch(env, skippedConfig, {
			concept: "calm earthy textures",
			classification: { mode: "motif", garment_part: "scarf" },
			systemPrompt: buildResearchSystemPrompt(),
			pipeline_id: "pipeline-research-3",
		});

		expect(result.context).toBeNull();
		expect(result.metadata.enabled).toBe(false);
		expect(result.metadata.queries).toEqual([]);
		expect(result.metadata.chunks).toEqual([]);
		expect(runToolLoop).not.toHaveBeenCalled();
	});

	it("passes image to the search query when provided", async () => {
		vi.mocked(runToolLoop).mockResolvedValueOnce({
			context: null,
			chunks: [],
			queries: [],
			iterations: 1,
			quality: "none",
		});

		await runResearch(env, config, {
			concept: "referenced pattern",
			classification: { mode: "tile" },
			systemPrompt: buildResearchSystemPrompt(),
			pipeline_id: "pipeline-research-4",
			image: { bytes: new Uint8Array([0xff, 0xd8]), contentType: "image/jpeg" },
		});

		expect(runToolLoop).toHaveBeenCalled();
	});
});
