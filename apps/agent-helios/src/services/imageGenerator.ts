import type { HeliosParams } from "@aureline/shared-types";
import { buildImagePrompt } from "../prompts";

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
 */
export async function generateImage(params: HeliosParams): Promise<GeneratedImage> {
	const prompt = buildImagePrompt(params);
	console.log("STUB: generateImage", prompt);
	return {
		image_url: "https://placeholder.invalid/helios-stub-pattern.png",
		// Left null until Workers AI pricing for the chosen model is confirmed.
		cost_usd: null,
	};
}
