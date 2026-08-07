import { buildPlannerSystemPrompt, buildPlannerUserPrompt } from "../prompts";
import { callPlannerModel } from "../tools";

/**
 * Textual planner stage: turns a free-text concept into Helios pattern parameters.
 *
 * Returns `unknown` deliberately. The real implementation calls a model, which
 * cannot guarantee the shape of what comes back — it is the pipeline's validate
 * stage that turns this into a trusted `HeliosParams`.
 *
 * Calls GPT-OSS-120B (or whatever env.PLANNER_MODEL points to) through AI
 * Gateway via callPlannerModel/getTextualModelOutput, using structured output.
 */
export async function planConcept(concept: string, env: Env, p_invoc_id: string) {
	const systemPrompt = buildPlannerSystemPrompt();
	const userPrompt = buildPlannerUserPrompt(concept);

	const result = await callPlannerModel(
		systemPrompt,
		userPrompt,
		env.PLANNER_MODEL,
		env.AI,
		{
			gateway: { id: env.AI_GATEWAY_ID, metadata: { p_invoc_id } },
			maxRetries: Number(env.MAX_RETRIES),
		}
	);

	// `buildAiRunOptions` returns undefined when the gateway id is empty, so a
	// dropped or misspelled AI_GATEWAY_ID quietly calls Workers AI directly:
	// no error, no gateway log entry, no metadata. `aiGatewayLogId` is null
	// until a routed call sets it, which makes it the only available signal
	// that the call actually went through the Gateway.
	if (!env.AI.aiGatewayLogId) {
		console.warn(`planner: call for ${p_invoc_id} did not route through AI Gateway`);
	}

	return result;
}