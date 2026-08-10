import type { HeliosDb } from "../db/client";
import {
	HeliosParamsSchema,
	type HeliosParams,
	type HeliosRequest,
	type HeliosResult,
} from "@aureline/shared-types";
import { planConcept } from "./planner";
import { generateImage } from "./imageGenerator";
import { describeError, extractNeuronCost } from "../utils";
import { describeConfig, resolveConfig, type HeliosConfig } from "../config";
import {
	startTextRun,
	completeTextRun,
	startImageRun,
	completeImageRun,
	failRunningRuns,
} from "../repository/do.repository";

type Stage = "persist" | "planner" | "validate" | "image";

/**
 * The image row's metadata, built from the config the run will actually use
 * rather than from literals — a hardcoded model name here would record a model
 * that was never called once `image_model` is changed in KV.
 *
 * Still a placeholder in one respect: ticket 06 replaces this with the usage the
 * real Flux Schnell call reports back.
 */
function imageModelMetadata(config: HeliosConfig) {
	return {
		model: config.imageModel.model,
		width: config.imageModel.width ?? null,
		height: config.imageModel.height ?? null,
		steps: config.imageModel.steps ?? null,
	};
}

/**
 * Fixed-order orchestrator: planner → validate → image generator.
 *
 * Never throws. Every path — including a stage blowing up, or DO storage
 * itself being unavailable — returns a `HeliosResult`, so the HTTP layer only
 * has to deal with settled outcomes. The failing stage is prefixed onto
 * `error` so failures stay attributable without a separate field.
 */
export async function runPipeline(db: HeliosDb, req: HeliosRequest, env: Env): Promise<HeliosResult> {
	// Read once per invocation so every stage sees the same snapshot. Reading
	// per-service instead would let two reads straddle a KV edit and produce a
	// `helios_runs` row that is half old model and half new (ADR-0001). Outside
	// the try because `resolveConfig` never throws.
	const config = await resolveConfig(env);
	console.log(describeConfig(config));

	// Identity of this pipeline invocation. Generated per invocation, NOT derived
	// from the Durable Object — one DO accumulates many invocations (ADR-0005).
	const p_invoc_id = crypto.randomUUID();

	let stage: Stage = "persist";
	let params: HeliosParams | null = null;

	try {
		// Inside the try so a storage failure is reported as a settled
		// `failed` result rather than escaping as an opaque 500.
		await startTextRun(db, p_invoc_id, req.concept, { model: config.textModel.model });

		stage = "planner";
		const planned = await planConcept(req.concept, env, config, p_invoc_id);

		stage = "validate";
		params = HeliosParamsSchema.parse(planned.data);

		const neurons = extractNeuronCost(planned.usage);
		const textModelMetadata = { model: planned.model, usage: planned.usage };

		// Planner succeeded — settle the text row, then open the image row.
		await completeTextRun(db, p_invoc_id, params, textModelMetadata, neurons);
		await startImageRun(db, p_invoc_id, req.concept, params, imageModelMetadata(config));

		stage = "image";
		const image = await generateImage(params, config, env, p_invoc_id);

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
		// Cleanup is itself a DO write, so it fails too when storage is what
		// broke — and a throw from inside a catch escapes the function. Swallow
		// it: `cause` is the failure worth reporting, this one is a symptom.
		try {
			await failRunningRuns(db, p_invoc_id);
		} catch (cleanupCause) {
			console.error("could not mark rows failed:", describeError(cleanupCause));
		}

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
