import type { HeliosDb } from "../db/client";
import {
	HeliosParamsSchema,
	type HeliosParams,
	type HeliosRequest,
	type HeliosResult,
} from "@aureline/shared-types";
import { planConcept } from "./planner";
import { generateImage } from "./imageGenerator";
import { describeError } from "../utils";
import {
	startTextRun,
	completeTextRun,
	startImageRun,
	completeImageRun,
	failRunningRuns,
} from "../repository/do.repository";

type Stage = "planner" | "validate" | "image";
/** Placeholder shape until ticket 05 (GPT-OSS-120B) reports real usage. */
const TEXT_MODEL_METADATA_STUB = {
	model: "gpt-oss-120b",
	provider: "openai",
	temperature: 1,
};

/** Placeholder shape until ticket 06 (Flux Schnell) reports real usage. */
const IMAGE_MODEL_METADATA_STUB = {
	model: "flux.1-schnell",
	provider: "black forest labs",
	width: 1024,
	height: 1024,
	steps: 4,
	seed: 0,
};

/**
 * Fixed-order orchestrator: planner → validate → image generator.
 *
 * Never throws. Every path — including a stage blowing up — returns a
 * `HeliosResult`, so the HTTP layer only has to deal with settled outcomes.
 * The failing stage is prefixed onto `error` so failures stay attributable
 * without a separate field.
 */
export async function runPipeline(db: HeliosDb, req: HeliosRequest): Promise<HeliosResult> {
	// Identity of this pipeline invocation. Generated per invocation, NOT derived
	// from the Durable Object — one DO accumulates many invocations (ADR-0005).
	const p_invoc_id = crypto.randomUUID();

	let stage: Stage = "planner";
	let params: HeliosParams | null = null;

	await startTextRun(db, p_invoc_id, req.concept, TEXT_MODEL_METADATA_STUB);

	try {
		const raw = await planConcept(req.concept);

		stage = "validate";
		params = HeliosParamsSchema.parse(raw);

		// Planner succeeded — settle the text row, then open the image row.
		await completeTextRun(db, p_invoc_id, params);
		await startImageRun(db, p_invoc_id, req.concept, params, IMAGE_MODEL_METADATA_STUB);

		stage = "image";
		const image = await generateImage(params);

		await completeImageRun(db, p_invoc_id, image.cost_usd);

		return {
			p_invoc_id,
			status: "completed",
			params,
			image_url: image.image_url,
			cost_usd: image.cost_usd,
			error: null,
		};
	} catch (cause) {
		await failRunningRuns(db, p_invoc_id);

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
