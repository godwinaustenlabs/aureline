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
import { and, eq } from "drizzle-orm";
import { heliosRuns } from "../db/schema";

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

	// A `running` text row, inserted before the planner call so a crash
	// mid-call still leaves an inspectable audit trail.
	await db.insert(heliosRuns).values({
		pInvocId: p_invoc_id,
		modality: "text",
		status: "running",
		userPrompt: req.concept,
		plannerParams: {},
		modelMetadata: TEXT_MODEL_METADATA_STUB,
	});

	try {
		const raw = await planConcept(req.concept);

		stage = "validate";
		params = HeliosParamsSchema.parse(raw);

		// Planner succeeded — settle the text row with real params, then open
		// the image row (duplicating planner_params per ADR-0001).
		await db
			.update(heliosRuns)
			.set({ status: "completed", plannerParams: params, completedAt: new Date() })
			.where(and(eq(heliosRuns.pInvocId, p_invoc_id), eq(heliosRuns.modality, "text")));

		await db.insert(heliosRuns).values({
			pInvocId: p_invoc_id,
			modality: "image",
			status: "running",
			userPrompt: req.concept,
			plannerParams: params,
			modelMetadata: IMAGE_MODEL_METADATA_STUB,
		});

		stage = "image";
		const image = await generateImage(params);

		await db
			.update(heliosRuns)
			.set({ status: "completed", costUsd: image.cost_usd, completedAt: new Date() })
			.where(and(eq(heliosRuns.pInvocId, p_invoc_id), eq(heliosRuns.modality, "image")));

		return {
			p_invoc_id,
			status: "completed",
			params,
			image_url: image.image_url,
			cost_usd: image.cost_usd,
			error: null,
		};
	} catch (cause) {
		// Mark whichever row is still `running` for this invocation as failed —
		// just the text row if planner/validate blew up, or the image row if
		// image generation did (text is already `completed` by that point).
		await db
			.update(heliosRuns)
			.set({ status: "failed", completedAt: new Date() })
			.where(and(eq(heliosRuns.pInvocId, p_invoc_id), eq(heliosRuns.status, "running")));

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
