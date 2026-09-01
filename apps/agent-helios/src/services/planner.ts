import { buildPlannerUserPrompt } from "../prompts";
import { callPlannerModel } from "../tools";
import type { HeliosConfig } from "../config";

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
	run: { concept: string; systemPrompt: string; pipeline_id: string }
) {
	const { concept, systemPrompt, pipeline_id } = run;
	const userPrompt = buildPlannerUserPrompt(concept);

	const result = await callPlannerModel(
		systemPrompt,
		userPrompt,
		config.textModel.model,
		env.AI,
		{
			gateway: { id: env.AI_GATEWAY_ID, metadata: { pipeline_id } },
			maxRetries: config.maxRetries,
			temperature: config.textModel.temperature,
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

	return result;
}