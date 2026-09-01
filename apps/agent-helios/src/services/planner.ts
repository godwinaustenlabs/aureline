import type { ReferenceImage } from "@aureline/shared-types";
import { buildPlannerUserPrompt } from "../prompts";
import { callPlannerModel } from "../tools";
import { plannerModelFor, type HeliosConfig } from "../config";

/**
 * Textual planner stage: turns a free-text concept into Helios pattern parameters.
 *
 * Returns `unknown` deliberately. The real implementation calls a model, which
 * cannot guarantee the shape of what comes back — it is the pipeline's validate
 * stage that turns this into a trusted `HeliosParams`.
 *
 * Calls GPT-OSS-120B (or whatever `config.textModel` resolves to) through AI
 * Gateway via callPlannerModel/getTextualModelOutput, using structured output.
 *
 * The model and retry count come from `config`, which is resolved from KV once
 * per invocation; `env` is still needed for the `AI` binding and the gateway id,
 * neither of which is runtime-tunable.
 *
 * `systemPrompt` arrives already resolved rather than being built here. The
 * caller reads it from the `prompts` table once per invocation, falling back to
 * `buildPlannerSystemPrompt()` when the row is missing — so this function stays
 * testable without a database and unaware of where the words came from.
 */
export async function planConcept(
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
		 * Absent, the call is byte-for-byte what it was before this existed —
		 * that is the regression promise, and it is why this is threaded through
		 * as an option rather than the call being restructured around it.
		 */
		image?: ReferenceImage;
	}
) {
	const { concept, systemPrompt, pipeline_id, image } = run;
	const userPrompt = buildPlannerUserPrompt(concept);

	// The vision model when one is configured, `textModel` otherwise. Resolved
	// once and used for both the model id and its temperature — reading the id
	// from one and the temperature from the other would tune a model that is not
	// the one being called.
	const model = plannerModelFor(config);

	// Which model, and whether the picture went with it. These two facts together
	// are what separates "the reference was ignored" from "the reference never
	// arrived" — and the vision model is used for every request, so a failure
	// here breaks text-only runs too.
	console.log(
		`planner: model=${model.model} images=${image === undefined ? 0 : 1} pipeline=${pipeline_id}`,
	);

	const result = await callPlannerModel(
		systemPrompt,
		userPrompt,
		model.model,
		env.AI,
		{
			gateway: { id: env.AI_GATEWAY_ID, metadata: { pipeline_id } },
			maxRetries: config.maxRetries,
			temperature: model.temperature,
			// Omitted entirely rather than passed as an empty array, so a text-only
			// request produces exactly today's request body.
			...(image !== undefined && {
				images: [{ bytes: image.bytes, contentType: image.contentType }],
			}),
		}
	);

	// `buildAiRunOptions` returns undefined when the gateway id is empty, so a
	// dropped or misspelled AI_GATEWAY_ID quietly calls Workers AI directly:
	// no error, no gateway log entry, no metadata. `aiGatewayLogId` is null
	// until a routed call sets it, which makes it the only available signal
	// that the call actually went through the Gateway.
	if (!env.AI.aiGatewayLogId) {
		console.warn(`planner: call for ${pipeline_id} did not route through AI Gateway`);
	}

	// The planner's own words, in full. It is the one field nothing else can
	// predict, and reading it beside the reference image is how you tell whether
	// the model actually looked at the picture.
	console.log(`planner: answered by ${result.model}, image_prompt="${result.data.image_prompt}"`);

	return result;
}