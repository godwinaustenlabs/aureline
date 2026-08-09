import type { HeliosParams } from "@aureline/shared-types";
import { buildImagePrompt } from "../prompts";
import type { HeliosConfig } from "../config";

export interface GeneratedImage {
	image_url: string;
	cost_usd: number | null;
}

/**
 * Image generation stage: renders a black-and-white pattern from the planner's
 * parameters, strictly following them (no unrequested creative drift).
 *
 * STUB — ticket 06 replaces this body with a real Flux Schnell call via Workers
 * AI, storing the result in R2 and returning its key. Flux 1.1 Pro is a later
 * drop-in swap behind this same signature (ADR-0004).
 *
 * `config` already carries the resolved image model so ticket 06 changes only
 * the body. Logging it while stubbed keeps the KV path verifiable at zero
 * Workers AI cost.
 */
export async function generateImage(
	params: HeliosParams,
	config: HeliosConfig
): Promise<GeneratedImage> {
	const prompt = buildImagePrompt(params);
	console.log("STUB: generateImage", config.imageModel.model, prompt);
	return {
		image_url: "https://placeholder.invalid/helios-stub-pattern.png",
		// Left null until Workers AI pricing for the chosen model is confirmed.
		cost_usd: null,
	};
}
