import type { Agent } from "agents";
import {
	HeliosParamsSchema,
	type HeliosParams,
	type HeliosRequest,
	type HeliosResult,
} from "@aureline/shared-types";
import { planConcept } from "./planner";
import { generateImage } from "./imageGenerator";
import { describeError } from "../utils";

type Stage = "planner" | "validate" | "image";

/**
 * Fixed-order orchestrator: planner → validate → image generator.
 *
 * Never throws. Every path — including a stage blowing up — returns a
 * `HeliosResult`, so the HTTP layer only has to deal with settled outcomes.
 * The failing stage is prefixed onto `error` so failures stay attributable
 * without a separate field.
 */
export async function runPipeline(agent: Agent<Env>, req: HeliosRequest): Promise<HeliosResult> {
	// Identity of this pipeline invocation. Generated per invocation, NOT derived
	// from the Durable Object — one DO accumulates many invocations (ADR-0005).
	const p_invoc_id = crypto.randomUUID();

	let stage: Stage = "planner";
	let params: HeliosParams | null = null;

	// Ticket 03 inserts `helios_runs` persistence here: a `running` row per model
	// call, keyed by (p_invoc_id, modality), updated as each stage settles.

	try {
		// throw new Error("Pipeline failure test."); // Test the failure response
		const raw = await planConcept(req.concept);

		stage = "validate";
		params = HeliosParamsSchema.parse(raw);

		console.log("\n\n===========================================================================================\n\n")

		stage = "image";
		const image = await generateImage(params);

		return {
			p_invoc_id,
			status: "completed",
			params,
			image_url: image.image_url,
			cost_usd: image.cost_usd,
			error: null,
		};
	} catch (cause) {
		return {
			p_invoc_id,
			status: "failed",
			// Retained if the planner already produced valid params — partial state
			// is kept rather than discarded, so a failure stays inspectable.
			params,
			image_url: null,
			cost_usd: null,
			error: `${stage}: ${describeError(cause)}`,
		};
	}
}
