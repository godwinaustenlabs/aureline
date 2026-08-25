import type { IrisParams } from "@aureline/shared-types";
import type { TextualModelOutput } from "@aureline/shared-utils";
import { buildPlannerSystemPrompt, buildPlannerUserPrompt } from "../prompts";
import { callPlannerModel } from "../tools";
import type { IrisConfig } from "../config";

/**
 * Textual planner stage: turns a free-text concept into Iris colour
 * parameters.
 *
 * Calls GPT-OSS-120B (or whatever `config.textModel` resolves to) through AI
 * Gateway via callPlannerModel/getTextualModelOutput, using structured output.
 *
 * Returns the helper's whole envelope, not just the params: `model` and `usage`
 * are what the text row records, and they are only knowable from the call. The
 * type is concrete rather than `unknown` because `getTextualModelOutput` has
 * already validated against `IrisParamsSchema` and retried until it passed, so
 * `unknown` would be a claim this function cannot support — and one the caller
 * could only act on by casting, which is how a wrong shape stops being visible
 * (AGENTS.md §4).
 *
 * The pipeline still parses `data` again at its validate stage. That is not
 * redundancy for its own sake: it is what keeps a schema failure attributable
 * to `validate:` rather than `planner:` (iris-08 decision 3).
 *
 * The model and retry count come from `config`, which is resolved from KV once
 * per invocation; `env` is still needed for the `AI` binding and the gateway id,
 * neither of which is runtime-tunable.
 */
export async function planConcept(
	concept: string,
	env: Env,
	config: IrisConfig,
	pipeline_id: string,
): Promise<TextualModelOutput<IrisParams>> {
	const systemPrompt = buildPlannerSystemPrompt();
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
		},
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
