import { describe, it, expect, vi } from "vitest";
import { classifyConcept } from "./classifier";
import { buildClassifierSystemPrompt } from "../prompts";
import { resolveConfig } from "../config";
import { fakeEnv } from "./test-env";

const CONCEPT = "an art deco paisley in fine linework";
const SYSTEM_PROMPT = buildClassifierSystemPrompt();
const PIPELINE_ID = "pipeline-1";

/** A whole reference image, not a partial plus a cast (AGENTS.md §5). */
const REFERENCE_IMAGE = {
	bytes: new Uint8Array([137, 80, 78, 71]) as Uint8Array<ArrayBuffer>,
	contentType: "image/png",
};

/** The reply shape `@cf/meta/llama-4-scout` actually returns for a JSON answer. */
function reply(classification: unknown) {
	return { response: JSON.stringify(classification), usage: { neurons: 8 } };
}

async function classify(overrides: Parameters<typeof fakeEnv>[0] = {}, image?: typeof REFERENCE_IMAGE) {
	const { env, run } = fakeEnv(overrides);
	const config = await resolveConfig(env);

	const result = await classifyConcept(env, config, {
		concept: CONCEPT,
		systemPrompt: SYSTEM_PROMPT,
		pipeline_id: PIPELINE_ID,
		...(image !== undefined && { image }),
	});

	return { result, run, env };
}

describe("classifyConcept", () => {
	it("classifies a repeating brief as a tile with no garment part", async () => {
		const { result } = await classify({ classifier: reply({ mode: "tile" }) });

		expect(result.data).toEqual({ mode: "tile" });
		expect(Object.hasOwn(result.data, "garment_part")).toBe(false);
	});

	it("classifies a motif that names a place, keeping the part", async () => {
		const { result } = await classify({
			classifier: reply({ mode: "motif", garment_part: "neckline" }),
		});

		expect(result.data).toEqual({ mode: "motif", garment_part: "neckline" });
	});

	it("classifies a motif that names no place, leaving the part absent", async () => {
		// "A single peacock motif" is a motif with nowhere to go. An invented part
		// would reach the image model as a real instruction.
		const { result } = await classify({ classifier: reply({ mode: "motif" }) });

		expect(result.data).toEqual({ mode: "motif" });
		expect(Object.hasOwn(result.data, "garment_part")).toBe(false);
	});

	it("throws on an unknown mode rather than defaulting to one", async () => {
		// A default here produces a run that completes looking entirely normal and
		// writes an audit row claiming a decision nobody made.
		await expect(classify({ classifier: reply({ mode: "sticker" }) })).rejects.toThrow(
			/schema validation failed/,
		);
	});

	it("throws when the reply has no mode at all", async () => {
		await expect(classify({ classifier: reply({ garment_part: "cuff" }) })).rejects.toThrow(
			/schema validation failed/,
		);
	});

	it("throws when the reply is not JSON", async () => {
		await expect(classify({ classifier: { response: "It is a tile." } })).rejects.toThrow();
	});

	it("lets a model call failure propagate, so the pipeline can fail the run", async () => {
		await expect(classify({ classifier: new Error("model unavailable") })).rejects.toThrow();
	});

	it("strips a field the model volunteered, so it cannot reach the column", async () => {
		// Parsing is what strips it, which is why callers must store `result.data`
		// and never the raw reply.
		const { result } = await classify({
			classifier: reply({ mode: "tile", confidence: 0.9, notes: "fairly sure" }),
		});

		expect(result.data).toEqual({ mode: "tile" });
	});
});

describe("classifyConcept and the model call", () => {
	it("calls the classifier model, not the planner's", async () => {
		const { run, env } = await classify();

		expect(run.mock.calls[0][0]).toBe(env.CLASSIFIER_MODEL);
		expect(run.mock.calls[0][0]).not.toBe(env.PLANNER_MODEL);
	});

	it("routes through the AI Gateway, tagged with the pipeline id", async () => {
		// ADR-0006. Unlike the research call that follows it, this one is gated and
		// its cost is read immediately afterwards (ADR-SHARED-0005).
		const { run } = await classify();

		expect(run.mock.calls[0][2]).toEqual({
			gateway: { id: "helios", metadata: { pipeline_id: PIPELINE_ID } },
		});
	});

	it("sends the resolved system prompt and the brief", async () => {
		const { run } = await classify();
		const body = run.mock.calls[0][1] as { messages: { role: string; content: unknown }[] };

		expect(body.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
		expect(body.messages[1]).toEqual({ role: "user", content: `Brief: ${CONCEPT}` });
	});

	it("asks the model for the classification schema, strictly", async () => {
		const { run } = await classify();
		const body = run.mock.calls[0][1] as {
			response_format: { type: string; json_schema: { strict: boolean; schema: { properties: unknown } } };
		};

		expect(body.response_format.type).toBe("json_schema");
		expect(body.response_format.json_schema.strict).toBe(true);
		expect(Object.keys(body.response_format.json_schema.schema.properties as object)).toEqual([
			"mode",
			"garment_part",
		]);
	});

	it("leaves max_tokens at the helper's default of 2048", async () => {
		// The answer is about thirty tokens, but a tight budget truncates the JSON
		// mid-object while the model is still thinking — which looks like the model
		// misbehaving, gets retried, and gets billed again (ADR-0007).
		const { run } = await classify();

		expect((run.mock.calls[0][1] as { max_tokens: number }).max_tokens).toBe(2048);
	});
});

describe("classifyConcept and the reference image", () => {
	it("sends the picture when one is attached", async () => {
		// A photograph of a repeating scarf print versus one of an embroidered
		// neckline is the signal that separates the two modes, often more clearly
		// than the words do.
		const { run } = await classify({}, REFERENCE_IMAGE);
		const body = run.mock.calls[0][1] as { messages: { content: unknown }[] };

		expect(body.messages[1].content).toEqual([
			{ type: "text", text: `Brief: ${CONCEPT}` },
			{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==" } },
		]);
	});

	it("sends a bare string when none is attached, not an empty array", async () => {
		// The regression promise: a text-only request produces exactly the body it
		// would have without this parameter existing.
		const { run } = await classify();
		const body = run.mock.calls[0][1] as { messages: { content: unknown }[] };

		expect(body.messages[1].content).toBe(`Brief: ${CONCEPT}`);
	});
});

describe("classifyConcept logging", () => {
	it("logs the decision, because everything downstream is shaped by it", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await classify({ classifier: reply({ mode: "motif", garment_part: "neckline" }) });

		expect(log).toHaveBeenCalledWith(expect.stringContaining("mode=motif part=neckline"));
		log.mockRestore();
	});

	it("logs the absent part as none rather than undefined", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await classify({ classifier: reply({ mode: "tile" }) });

		expect(log).toHaveBeenCalledWith(expect.stringContaining("mode=tile part=none"));
		log.mockRestore();
	});

	it("warns when the call did not route through the gateway", async () => {
		// An empty AI_GATEWAY_ID calls Workers AI directly: no error, no log, no
		// cost. `aiGatewayLogId` staying null is the only available signal.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await classify({ aiGatewayLogId: null });

		expect(warn).toHaveBeenCalledWith(expect.stringContaining("did not route through AI Gateway"));
		warn.mockRestore();
	});
});
