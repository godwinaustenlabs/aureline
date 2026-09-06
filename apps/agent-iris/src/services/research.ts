import type { Classification, ReferenceImage, SearchQuality } from "@aureline/shared-types";
import { runToolLoop, SEARCH_TOOL, type RunToolLoopConfig } from "@aureline/shared-utils";
import { toDataUrl } from "@aureline/shared-utils";
import { buildResearchUserPrompt } from "../prompts";
import { researchModelFor, type IrisConfig } from "../config";

/**
 * The AI Search instance this engine searches.
 *
 * Hardcoded because there is no accessor for it: the binding exposes the
 * instance's methods, not its name. It is the string from `wrangler.jsonc`, and
 * the two have to be changed together.
 */
const INSTANCE = "iris-kb";

/**
 * What the research stage records on the audit row.
 *
 * Keys and scores, never the retrieved text. The text runs to tens of kilobytes
 * per run and is reproducible from the query; the keys are what answer "which
 * document made it say that".
 */
export interface RetrievalMetadata {
	instance: string;
	/** False when `research_model` is empty — the stage was skipped, not failed. */
	enabled: boolean;
	/** What the model actually chose to search for, in order. */
	queries: string[];
	chunks: Array<{ key: string; score: number; chars: number }>;
	/** Model calls made. Not the number of searches. */
	iterations: number;
	quality: SearchQuality;
	/**
	 * Always `null`, never `0`, and never read from the gateway.
	 *
	 * The research call is ungated by decision (ADR-SHARED-0005), so there is no
	 * gateway log to read a cost from. `0` would state that several billed model
	 * calls were free; `null` states that we did not measure them, which is true.
	 */
	cost_usd: null;
}

export interface ResearchResult {
	/** The `<source>` blocks for the planner's `constraints` slot, or null. */
	context: string | null;
	metadata: RetrievalMetadata;
}

/** The metadata for a run where retrieval never happened. */
function skipped(): RetrievalMetadata {
	return {
		instance: INSTANCE,
		enabled: false,
		queries: [],
		chunks: [],
		iterations: 0,
		quality: "none",
		cost_usd: null,
	};
}

/**
 * Research stage: the model is handed a knowledge-base search tool and decides
 * for itself whether and what to search.
 *
 * **Never throws for want of a knowledge base.** An empty or unindexed instance
 * produces a completed run with `quality: "thin"`, and an unset `research_model`
 * produces one with `enabled: false` — both working states.
 *
 * **Ungated.** No gateway id reaches `ai.run`, so these calls appear in no
 * gateway log and have no cost figure. That is ADR-SHARED-0005 working as
 * designed, not a routing bug.
 */
export async function runResearch(
	env: Env,
	config: IrisConfig,
	run: {
		concept: string;
		classification: Classification;
		systemPrompt: string;
		pipeline_id: string;
		image?: ReferenceImage;
	},
): Promise<ResearchResult> {
	const { concept, classification, systemPrompt, pipeline_id, image } = run;

	const model = researchModelFor(config);

	// Null is the off switch, not an error. `researchModelFor` has already logged
	// which it was, so this only records the skip on the row.
	if (model === null) {
		console.log(`research: skipped, no model configured pipeline=${pipeline_id}`);
		return { context: null, metadata: skipped() };
	}

	const userPrompt = buildResearchUserPrompt(concept, classification);

	console.log(
		`research: model=${model.model} mode=${classification.mode} images=${image === undefined ? 0 : 1} pipeline=${pipeline_id}`,
	);

	const messages: Record<string, unknown>[] = [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userContent(userPrompt, image) },
	];

	const toolConfig: RunToolLoopConfig = {
		maxToolIterations: config.maxToolIterations,
		maxSearchResults: config.maxSearchResults,
		minChunkChars: config.minChunkChars,
		searchMatchThreshold: config.searchMatchThreshold,
		queryRewrite: config.queryRewrite,
	};

	const loop = await runToolLoop(env, toolConfig, {
		model: model.model,
		messages,
		tools: [SEARCH_TOOL],
	});

	console.log(
		`research: queries=${loop.queries.length} chunks=${loop.chunks.length} iterations=${loop.iterations} quality=${loop.quality} pipeline=${pipeline_id}`,
	);

	if (loop.quality !== "ok") {
		console.warn(
			`research: retrieval was ${loop.quality} for ${pipeline_id} — the planner is proceeding on ${loop.chunks.length} chunk(s)`,
		);
	}

	return {
		context: loop.context,
		metadata: {
			instance: INSTANCE,
			enabled: true,
			queries: loop.queries,
			chunks: loop.chunks,
			iterations: loop.iterations,
			quality: loop.quality,
			cost_usd: null,
		},
	};
}

/**
 * The user turn's content: a bare string, or text plus image parts.
 *
 * Built here rather than by reusing `getTextualModelOutput`'s `buildUserContent`,
 * which is module-private.
 */
function userContent(prompt: string, image: ReferenceImage | undefined): unknown {
	if (image === undefined) return prompt;

	return [
		{ type: "text", text: prompt },
		{ type: "image_url", image_url: { url: toDataUrl(image.bytes, image.contentType) } },
	];
}
