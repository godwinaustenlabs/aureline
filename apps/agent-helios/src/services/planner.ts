import type { HeliosParams } from "@aureline/shared-types";
import { buildPlannerSystemPrompt, buildPlannerUserPrompt } from "../prompts";

/**
 * Textual planner stage: turns a free-text concept into Helios pattern parameters.
 *
 * Returns `unknown` deliberately. The real implementation calls a model, which
 * cannot guarantee the shape of what comes back — it is the pipeline's validate
 * stage that turns this into a trusted `HeliosParams`.
 *
 * STUB — ticket 05 replaces this body with a real GPT-OSS-120B structured-output
 * call via Workers AI. The signature is already final; callers do not change.
 */
export async function planConcept(concept: string): Promise<unknown> {
	const systemPrompt = buildPlannerSystemPrompt();
	const userPrompt = buildPlannerUserPrompt(concept);

	console.log("planner system prompt:", systemPrompt);
	console.log("planner user prompt:", userPrompt);
	
	const canned: HeliosParams = {
		motif_type: "floral",
		repeat_type: "half-drop",
		scale: "medium",
		density: "balanced",
		line_weight: "medium",
		texture_technique: "hatching",
		contrast_level: "high",
		style: "traditional",
	};
	return canned;
}
