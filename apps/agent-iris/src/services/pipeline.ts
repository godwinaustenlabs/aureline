import type { IrisDb } from "../db/client";
import { IrisParamsSchema, type IrisParams, type IrisRequest, type IrisResult } from "@aureline/shared-types";
import { planConcept } from "./planner";
import { colorizeMotif } from "./colorizer";
import { saveColoredImage } from "../repository/r2.repository";
import { describeError } from "../utils";
import { describeConfig, resolveConfig, type IrisConfig } from "../config";
import {
	startTextRun,
	completeTextRun,
	startImageRun,
	insertFailedImageRun,
	completeImageRun,
	failRunningRuns,
	getRunRows,
} from "../repository/do.repository";

type Stage = "persist" | "planner" | "validate" | "image";

/**
 * What the image stage reports back to whoever called it.
 *
 * The cost rides on **both** branches deliberately. The real model bills
 * before the R2 save and the row update run, so a caller that only learned
 * the cost on success would record a spent image as having cost nothing.
 */
type ImageStageOutcome =
	| { ok: true; imageR2Key: string; costUsd: number | null; width: number | null; height: number | null }
	| { ok: false; cause: unknown; costUsd: number | null };

/**
 * The image row's metadata, built from the config the run will actually use
 * rather than from literals — a hardcoded model name here would record a model
 * that was never called once `image_model` is changed in KV.
 */
function imageModelMetadata(config: IrisConfig): Record<string, unknown> {
	return { model: config.imageModel.model };
}

/**
 * Exports settled rows to D1 and prunes the DO down to the retention limit.
 *
 * A no-op for now — iris-11 owns the real D1 export and pruning — but the call
 * site is in place at both the success and the failure exit, exactly where
 * iris-11 needs it, so that ticket changes a function body rather than having
 * to find two new call sites first.
 *
 * Never throws. Export is an audit concern, not something that should cost the
 * caller their result after they already waited on the pipeline.
 */
export async function exportAndPrune(
	db: IrisDb,
	env: Env,
	p_invoc_id: string,
	retentionLimit: number,
): Promise<void> {
	// iris-11: export getSettledRows(db) to D1, then pruneCompletedRuns(db, retentionLimit).
}

/**
 * Everything from the image row opening to the image row settling: the row,
 * the model call, the R2 save, and the row update.
 *
 * It exists as its own function only so `/resume` (iris-10) can enter the
 * pipeline here, with params read back from storage instead of from the
 * planner. Keeping one copy of the image path means a change to how images
 * are made lands in one place rather than two.
 *
 * **Builds no `IrisResult`.** Both callers track their own `stage` and
 * `params` and shape their own result, so result building stays whole in one
 * place per caller instead of being split across two functions.
 *
 * Never throws. A failure comes back as `ok: false` carrying the cause, so the
 * caller decides what a failed image means for its own result.
 *
 * **Always leaves an image row behind.** If opening the row is what failed, one
 * is inserted already `failed`, so an invocation is two rows whether it
 * succeeded or not (ADR-0001). Without it, this failure leaves the invocation
 * as a lone `completed` text row that looks like a success and gets pruned
 * like one.
 *
 * `metadataExtras` is merged over the image row's model metadata. `runPipeline`
 * passes nothing; iris-10's resume passes its `resumed_from` and `attempt`
 * markers, which have to land on this row because it is the one carrying
 * `cost_usd` and `image_r2_key` and therefore the one every cost query reads.
 */
export async function runImageStage(
	db: IrisDb,
	env: Env,
	config: IrisConfig,
	p_invoc_id: string,
	sourcePInvocId: string,
	concept: string,
	motifRef: string,
	params: IrisParams,
	metadataExtras: Record<string, unknown> = {},
): Promise<ImageStageOutcome> {
	// Assigned the moment the model returns, so it is already set if the R2 save
	// or the row update throws after the call has billed.
	let costUsd: number | null = null;

	// Built once so the rescue insert below records the same model as the row
	// that was meant to open.
	const modelMetadata = { ...imageModelMetadata(config), ...metadataExtras };

	// Whether the image row exists. If opening it is what failed, the caller's
	// `failRunningRuns` has nothing to mark, and the invocation settles as a lone
	// `completed` text row.
	let rowOpened = false;

	try {
		await startImageRun(db, p_invoc_id, sourcePInvocId, concept, motifRef, params, modelMetadata);
		rowOpened = true;

		const image = await colorizeMotif(motifRef, params, config, env, p_invoc_id);
		costUsd = image.cost_usd;

		const imageR2Key = await saveColoredImage(env.PATTERNS, p_invoc_id, image.image, image.contentType);

		// Persisted here, not just returned: model_metadata is the only durable
		// home width/height have (there is no column and there deliberately never
		// will be one, iris-03 decision 9).
		await completeImageRun(db, p_invoc_id, imageR2Key, costUsd, { width: image.width, height: image.height });

		// Read back from what was just stored, rather than trusting `image.width`
		// and `image.height` directly, so a bug in the write path shows up here
		// instead of hiding until Atlas reads a pruned run.
		const rows = await getRunRows(db, p_invoc_id);
		const imageRow = rows.find((row) => row.modality === "image");
		const storedMetadata = (imageRow?.modelMetadata ?? {}) as { width?: unknown; height?: unknown };

		return {
			ok: true,
			imageR2Key,
			costUsd,
			width: typeof storedMetadata.width === "number" ? storedMetadata.width : null,
			height: typeof storedMetadata.height === "number" ? storedMetadata.height : null,
		};
	} catch (cause) {
		if (!rowOpened) {
			// Its own try, and swallowed: the usual reason opening the row failed is
			// that DO storage is unavailable, in which case this write fails too.
			// Nothing can be recorded then, and `cause` is still the failure worth
			// reporting.
			try {
				await insertFailedImageRun(db, p_invoc_id, sourcePInvocId, concept, motifRef, params, modelMetadata);
			} catch (rescueCause) {
				console.error(`could not record the unopened image row for ${p_invoc_id}:`, describeError(rescueCause));
			}
		}

		return { ok: false, cause, costUsd };
	}
}

/**
 * Fixed-order orchestrator: planner → validate → image.
 *
 * Never throws. Every path — including a stage blowing up, or DO storage
 * itself being unavailable — returns an `IrisResult`, so the HTTP layer only
 * has to deal with settled outcomes. The failing stage is prefixed onto
 * `error` so failures stay attributable without a separate column.
 */
export async function runPipeline(db: IrisDb, req: IrisRequest, env: Env, origin: string): Promise<IrisResult> {
	// Read once per invocation so every stage sees the same snapshot. Reading
	// per-service instead would let two reads straddle a KV edit and produce one
	// invocation whose text row says one model and whose image row says another.
	// Outside the try because `resolveConfig` never throws.
	const config = await resolveConfig(env);
	console.log(describeConfig(config));

	// Identity of this pipeline invocation. Generated per invocation, NOT derived
	// from the Durable Object — one DO accumulates many invocations (ADR-0005).
	const p_invoc_id = crypto.randomUUID();

	let stage: Stage = "persist";
	let params: IrisParams | null = null;
	// Held outside the try because the image call bills before the R2 save and
	// the row update run. Without this, a failure in either records a spent
	// image as having cost nothing.
	let imageCost: number | null = null;

	try {
		// Inside the try so a storage failure is reported as a settled `failed`
		// result rather than escaping as an opaque 500.
		await startTextRun(db, p_invoc_id, req.source_p_invoc_id, req.concept, req.motif_ref, {
			model: config.textModel.model,
		});

		stage = "planner";
		const planned = await planConcept(req.concept, env, config, p_invoc_id);

		stage = "validate";
		params = IrisParamsSchema.parse(planned);

		const textModelMetadata = { model: config.textModel.model };

		// Planner succeeded — settle the text row before the image row opens. No
		// real cost yet: the planner call is faked in this ticket.
		await completeTextRun(db, p_invoc_id, params, textModelMetadata, null);

		stage = "image";
		const outcome = await runImageStage(
			db,
			env,
			config,
			p_invoc_id,
			req.source_p_invoc_id,
			req.concept,
			req.motif_ref,
			params,
		);

		// Recorded before anything can throw, so the catch below reports what the
		// image actually cost rather than null.
		imageCost = outcome.costUsd;
		if (!outcome.ok) {
			throw outcome.cause;
		}

		await exportAndPrune(db, env, p_invoc_id, config.retentionLimit);

		return {
			p_invoc_id,
			source_p_invoc_id: req.source_p_invoc_id,
			status: "completed",
			params,
			image_url: `${origin}/images/${outcome.imageR2Key}`,
			width: outcome.width,
			height: outcome.height,
			cost_usd: imageCost,
			error: null,
		};
	} catch (cause) {
		// Cleanup is itself a DO write, so it fails too when storage is what
		// broke — and a throw from inside a catch escapes the function. Swallow
		// it: `cause` is the failure worth reporting, this one is a symptom.
		try {
			await failRunningRuns(db, p_invoc_id, imageCost);

			// Every invocation is two rows, whether it succeeded or not (ADR-0001).
			// A failure at "persist", "planner" or "validate" never reaches
			// `runImageStage`, so nothing has opened an image row yet — without
			// this, the invocation would settle as a single failed text row.
			if (stage === "persist" || stage === "planner" || stage === "validate") {
				await insertFailedImageRun(
					db,
					p_invoc_id,
					req.source_p_invoc_id,
					req.concept,
					req.motif_ref,
					params ?? ({} as IrisParams),
					imageModelMetadata(config),
				);
			}
		} catch (cleanupCause) {
			console.error("could not mark rows failed:", describeError(cleanupCause));
		}

		await exportAndPrune(db, env, p_invoc_id, config.retentionLimit);

		return {
			p_invoc_id,
			source_p_invoc_id: req.source_p_invoc_id,
			status: "failed",
			// Retained if the planner already produced valid params — partial
			// state is kept rather than discarded, so a failure stays inspectable.
			params,
			image_url: null,
			width: null,
			height: null,
			// Non-null only when the image was generated and something after it
			// broke. The money left the account either way, so it is reported.
			cost_usd: imageCost,
			error: `${stage}: ${describeError(cause)}`,
		};
	}
}
