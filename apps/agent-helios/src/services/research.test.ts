import { describe, it, expect, vi } from "vitest";
import type { Classification } from "@aureline/shared-types";
import { SEARCH_TOOL } from "@aureline/shared-utils";
import { runResearch } from "./research";
import { buildResearchSystemPrompt } from "../prompts";
import { resolveConfig } from "../config";
import { fakeEnv } from "./test-env";
import * as gatewayCost from "./gatewayCost";

/** A model id distinct from every other one the fake dispatches on. */
const RESEARCH_MODEL = "@cf/test/research-model";

const CONCEPT = "an art deco paisley in fine linework";
const TILE: Classification = { mode: "tile" };
const MOTIF: Classification = { mode: "motif", garment_part: "neckline" };
const PIPELINE_ID = "pipeline-1";

const REFERENCE_IMAGE = {
	bytes: new Uint8Array([137, 80, 78, 71]) as Uint8Array<ArrayBuffer>,
	contentType: "image/png",
};

/** A reply asking for one search, in the flat shape the vision model returns. */
function asksToSearch(query: string) {
	return { response: "", tool_calls: [{ id: "call-1", function: { name: SEARCH_TOOL.name, arguments: { query } } }] };
}

function chunk(key: string, text: string, score = 0.8) {
	return { id: `${key}#0`, type: "text", score, text, item: { key } };
}

async function research(
	overrides: Parameters<typeof fakeEnv>[0] = {},
	run: { classification?: Classification; image?: typeof REFERENCE_IMAGE } = {},
) {
	const fake = fakeEnv({ researchModel: RESEARCH_MODEL, ...overrides });
	const config = await resolveConfig(fake.env);
	const classification = run.classification ?? TILE;

	const result = await runResearch(fake.env, config, {
		concept: CONCEPT,
		classification,
		systemPrompt: buildResearchSystemPrompt(classification),
		pipeline_id: PIPELINE_ID,
		...(run.image !== undefined && { image: run.image }),
	});

	return { ...fake, result };
}

describe("runResearch when retrieval is switched off", () => {
	it("skips the stage entirely when no research model is configured", async () => {
		// `research_model: ""` is the off switch, and this is the state every run is
		// in until a human turns it on from KV. It must be a completed, ordinary run
		// — that is what let this phase ship before the knowledge base existed.
		const fake = fakeEnv();
		const config = await resolveConfig(fake.env);

		const result = await runResearch(fake.env, config, {
			concept: CONCEPT,
			classification: TILE,
			systemPrompt: buildResearchSystemPrompt(TILE),
			pipeline_id: PIPELINE_ID,
		});

		expect(result).toEqual({
			context: null,
			metadata: {
				instance: "HelioKB",
				enabled: false,
				queries: [],
				chunks: [],
				iterations: 0,
				quality: "none",
				cost_usd: null,
			},
		});
	});

	it("makes no model call and no search when it is off", async () => {
		const fake = fakeEnv();
		const config = await resolveConfig(fake.env);

		await runResearch(fake.env, config, {
			concept: CONCEPT,
			classification: TILE,
			systemPrompt: "x",
			pipeline_id: PIPELINE_ID,
		});

		expect(fake.run).not.toHaveBeenCalled();
		expect(fake.search).not.toHaveBeenCalled();
	});

	it("logs the skip, so an off stage is distinguishable from one that found nothing", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const fake = fakeEnv();
		const config = await resolveConfig(fake.env);

		await runResearch(fake.env, config, {
			concept: CONCEPT,
			classification: TILE,
			systemPrompt: "x",
			pipeline_id: PIPELINE_ID,
		});

		expect(log).toHaveBeenCalledWith(expect.stringContaining("research: skipped, no model configured"));
		log.mockRestore();
	});
});

describe("runResearch is ungated", () => {
	it("calls the model with two arguments, never a third", async () => {
		// ADR-SHARED-0005. Asserted as arity rather than `calls[0][2] === undefined`,
		// which would also pass if a later edit passed an explicit undefined.
		const { run } = await research();

		expect(run.mock.calls[0].length).toBe(2);
	});

	it("never reads a cost from the gateway", async () => {
		// An ungated call does not clear `aiGatewayLogId`, so a read here would
		// return the CLASSIFIER's cost and file it under research.
		const spy = vi.spyOn(gatewayCost, "readGatewayCost");

		await research();

		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("records the cost as null, never zero", async () => {
		// Zero would state that several billed model calls were free. ADR-0007.
		const { result } = await research();

		expect(result.metadata.cost_usd).toBeNull();
	});
});

describe("runResearch and the model call", () => {
	it("calls the research model, not the planner's or the classifier's", async () => {
		const { run, env } = await research();

		expect(run.mock.calls[0][0]).toBe(RESEARCH_MODEL);
		expect(run.mock.calls[0][0]).not.toBe(env.PLANNER_MODEL);
		expect(run.mock.calls[0][0]).not.toBe(env.CLASSIFIER_MODEL);
	});

	it("hands the model the search tool", async () => {
		const { run } = await research();

		expect((run.mock.calls[0][1] as { tools: unknown }).tools).toEqual([SEARCH_TOOL]);
	});

	it("sends the resolved system prompt and the brief with its classification", async () => {
		const { run } = await research({}, { classification: MOTIF });
		const body = run.mock.calls[0][1] as { messages: { role: string; content: unknown }[] };

		expect(body.messages[0]).toEqual({ role: "system", content: buildResearchSystemPrompt(MOTIF) });
		expect(body.messages[1]).toEqual({
			role: "user",
			content: `Brief: ${CONCEPT}\nDesign mode: motif\nGarment part: neckline`,
		});
	});

	it("carries the classification in the user turn, not only the system prompt", async () => {
		// The system prompt is database-backed, and a stored row is a static string
		// with no classification in it. Without this the mode would silently vanish
		// on every run where somebody has edited the prompt in the playground.
		const { run } = await research({}, { classification: TILE });
		const body = run.mock.calls[0][1] as { messages: { content: unknown }[] };

		expect(String(body.messages[1].content)).toContain("Design mode: tile");
	});

	it("passes the reference image when one is attached", async () => {
		const { run } = await research({}, { image: REFERENCE_IMAGE });
		const body = run.mock.calls[0][1] as { messages: { content: unknown }[] };

		expect(body.messages[1].content).toEqual([
			{ type: "text", text: `Brief: ${CONCEPT}\nDesign mode: tile` },
			{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==" } },
		]);
	});

	it("sends a bare string when there is no image, not a one-element array", async () => {
		const { run } = await research();
		const body = run.mock.calls[0][1] as { messages: { content: unknown }[] };

		expect(body.messages[1].content).toBe(`Brief: ${CONCEPT}\nDesign mode: tile`);
	});
});

describe("runResearch and the search", () => {
	it("passes the tuning knobs through to AI Search", async () => {
		const { search } = await research({ research: [asksToSearch("seamless repeats")] });

		expect(search).toHaveBeenCalledWith({
			query: "seamless repeats",
			ai_search_options: {
				retrieval: { max_num_results: 5, match_threshold: 0.5 },
				query_rewrite: { enabled: false },
			},
		});
	});

	it("renders retrieved chunks as source blocks for the planner", async () => {
		const { result } = await research({
			research: [asksToSearch("tiling")],
			search: {
				search_query: "tiling",
				chunks: [chunk("tiling.md", "Edges must meet."), chunk("scale.md", "Keep it small.")],
			},
		});

		expect(result.context).toBe(
			'<source name="tiling.md">Edges must meet.</source>\n\n<source name="scale.md">Keep it small.</source>',
		);
	});

	it("records provenance and length but never the retrieved text", async () => {
		// The text runs to tens of kilobytes and is reproducible from the query.
		// The key is what answers "which document made it say that".
		const { result } = await research({
			research: [asksToSearch("tiling")],
			search: { search_query: "tiling", chunks: [chunk("tiling.md", "z".repeat(300), 0.91)] },
		});

		expect(result.metadata.chunks).toEqual([{ key: "tiling.md", score: 0.91, chars: 300 }]);
		expect(JSON.stringify(result.metadata)).not.toContain("zzz");
	});

	it("records what the model chose to search for", async () => {
		const { result } = await research({ research: [asksToSearch("art deco lattice")] });

		expect(result.metadata.queries).toEqual(["art deco lattice"]);
	});

	it("lets an AI Search exception stop the run", async () => {
		// Unlike an empty knowledge base, which completes. The pipeline's catch
		// turns this into `research: …` with a resume option.
		await expect(
			research({ research: [asksToSearch("q")], search: new Error("AI Search unavailable") }),
		).rejects.toThrow("AI Search unavailable");
	});
});

describe("runResearch quality", () => {
	it("is none when the model chose not to search", async () => {
		// A legitimate completing outcome, not a failure.
		const { result } = await research();

		expect(result.metadata).toMatchObject({ enabled: true, quality: "none", queries: [] });
		expect(result.context).toBeNull();
	});

	it("is thin when the instance has nothing indexed", async () => {
		// The state every run is in before a human uploads the knowledge base.
		const { result } = await research({ research: [asksToSearch("anything")] });

		expect(result.metadata.quality).toBe("thin");
		expect(result.context).toBeNull();
	});

	it("is ok once enough text comes back", async () => {
		const { result } = await research({
			research: [asksToSearch("tiling")],
			search: { search_query: "tiling", chunks: [chunk("a.md", "z".repeat(200))] },
		});

		expect(result.metadata.quality).toBe("ok");
	});

	it("warns when the planner is about to proceed under-grounded", async () => {
		// A run that reached the planner with nothing looks identical to a healthy
		// one from everywhere except this line and the audit row.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await research({ research: [asksToSearch("anything")] });

		expect(warn).toHaveBeenCalledWith(expect.stringContaining("retrieval was thin"));
		warn.mockRestore();
	});

	it("does not warn when retrieval went well", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await research({
			research: [asksToSearch("tiling")],
			search: { search_query: "tiling", chunks: [chunk("a.md", "z".repeat(200))] },
		});

		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe("runResearch metadata", () => {
	it("names the instance it actually searched", async () => {
		// The string must match wrangler.jsonc's `instance_name`. A mismatch writes
		// an audit row naming an instance the run never touched.
		const { result } = await research();

		expect(result.metadata.instance).toBe("HelioKB");
	});

	it("counts model calls as iterations, not searches", async () => {
		const { result, search } = await research({ research: [asksToSearch("q")] });

		// Two model calls: one that asked to search, one that answered. But only
		// one search. Reporting iterations as searches would understate the billed
		// calls, which is the number that matters for what a run cost.
		expect(result.metadata.iterations).toBe(2);
		expect(result.metadata.queries).toHaveLength(1);
		expect(search).toHaveBeenCalledTimes(1);
	});
});
