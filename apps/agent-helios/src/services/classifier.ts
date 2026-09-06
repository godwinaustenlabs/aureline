import { ClassificationSchema, type Classification, type ReferenceImage } from "@aureline/shared-types";
import { getTextualModelOutput, type TextualModelOutput } from "@aureline/shared-utils";
import type { HeliosConfig } from "../config";

/**
 * Classify stage: decides whether a brief is a repeating tile or a single motif,
 * and which part of a garment a motif is for.
 *
 * **The least novel thing in Phase 2, deliberately.** It reuses
 * `getTextualModelOutput` entirely unchanged — same Chat Completions shape, same
 * `response_format: json_schema, strict: true`, same gateway config, same retry
 * loop, same `maxRetries` from config. The only differences from `planConcept`
 * are the schema and the model. Everything novel about this phase lives in the
 * research stage; the classifier is an ordinary planner call with two fields.
 *
 * **Runs once, in Helios, before anything else.** Other engines read the answer
 * rather than deciding again, so a second opinion here would be a second answer
 * that could disagree with the first (`phase-2-plan.md` §3).
 *
 * **Failure throws**, and `runPipeline`'s existing catch records it as
 * `classify: …` and fails both rows. There is no default mode: a run grounded on
 * a guessed classification completes looking entirely normal and writes an audit
 * row claiming a decision nobody made.
 *
 * `systemPrompt` arrives already resolved, exactly as it does for the planner —
 * the caller reads it from the `prompts` table once per invocation, so this
 * function stays testable without a database and unaware of where the words came
 * from.
 */
export async function classifyConcept(
	env: Env,
	config: HeliosConfig,
	/**
	 * One object rather than three positional strings (AGENTS.md §6). `concept`
	 * and `systemPrompt` are both strings and adjacent, and swapping them sends
	 * the brief as the system prompt and the prompt as the brief — a full-price
	 * call that returns nonsense and nothing in the types would object.
	 */
	run: {
		concept: string;
		systemPrompt: string;
		pipeline_id: string;
		/**
		 * The user's reference image, when they attached one.
		 *
		 * Passed here as well as to the planner, because a photograph of a
		 * repeating scarf print versus one of an embroidered neckline is precisely
		 * the signal that separates the two modes — often more clearly than the
		 * words do.
		 */
		image?: ReferenceImage;
	},
): Promise<TextualModelOutput<Classification>> {
	const { concept, systemPrompt, pipeline_id, image } = run;

	const model = config.classifierModel;

	console.log(
		`classify: model=${model.model} images=${image === undefined ? 0 : 1} pipeline=${pipeline_id}`,
	);

	const result = await getTextualModelOutput(ClassificationSchema, `Brief: ${concept}`, model.model, env.AI, {
		instructions: systemPrompt,
		// Routed through the gateway (ADR-0006), unlike the research call that
		// follows it. The pipeline reads this cost immediately afterwards, which is
		// what keeps it attributable — see ADR-SHARED-0005 for why the ordering of
		// gated and ungated calls in this pipeline is load-bearing.
		gateway: { id: env.AI_GATEWAY_ID, metadata: { pipeline_id } },
		maxRetries: config.maxRetries,
		temperature: model.temperature,
		// `maxOutputTokens` is deliberately left at the helper's default of 2048.
		// The answer is about thirty tokens, but gpt-oss-style models spend part of
		// their budget thinking before they write, and ADR-0007 records exactly what
		// a too-tight budget does: the JSON truncates mid-object, looks like the
		// model misbehaving, and gets retried and billed again.
		//
		// Omitted entirely rather than passed as an empty array, so a text-only
		// request produces exactly the body it would have without this parameter.
		...(image !== undefined && {
			images: [{ bytes: image.bytes, contentType: image.contentType }],
		}),
	});

	// `buildAiRunOptions` returns undefined when the gateway id is empty, so a
	// dropped or misspelled AI_GATEWAY_ID quietly calls Workers AI directly: no
	// error, no gateway log, no cost. `aiGatewayLogId` is null until a routed call
	// sets it, which makes it the only available signal that this one was routed.
	if (!env.AI.aiGatewayLogId) {
		console.warn(`classify: call for ${pipeline_id} did not route through AI Gateway`);
	}

	// The decision itself, because everything downstream is shaped by it: the
	// research queries, the planner's constraints, and which clause the image
	// prompt uses. A run that came out wrong is usually a run that classified
	// wrong, and this is the line that says so.
	console.log(
		`classify: answered by ${result.model}, mode=${result.data.mode} part=${result.data.garment_part ?? "none"}`,
	);

	return result;
}
