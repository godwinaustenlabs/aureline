import { getD1Db, type IrisDb } from "../db/client";
import { IrisParamsSchema, type IrisParams, type IrisRequest, type IrisResult } from "@aureline/shared-types";
import { planConcept } from "./planner";
import { colorizeMotif } from "./colorizer";
import { readGatewayCost } from "./gatewayCost";
import { saveColoredImage } from "../repository/r2.repository";
import { describeError } from "../utils";
import { describeConfig, describePrompt, resolveConfig, resolvePrompt, type IrisConfig } from "../config";
import { buildPlannerSystemPrompt, IRIS_COLOR_PROMPT_VERSION, IRIS_PLANNER_PROMPT_VERSION } from "../prompts";
import {
	startTextRun,
	completeTextRun,
	startImageRun,
	insertFailedImageRun,
	completeImageRun,
	failRunningRuns,
	getRunRows,
	getSettledRows,
	pruneCompletedRuns,
} from "../repository/do.repository";
import { exportRuns } from "../repository/d1.repository";

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
	// The prompt version travels with the model, so a run's colours stay
	// attributable to the wording that produced them. That is the entire reason
	// iris-04 versions its prompts rather than editing them in place.
	return { model: config.imageModel.model, prompt_version: IRIS_COLOR_PROMPT_VERSION };
}

/**
 * Exports settled rows to D1 and prunes the DO down to the retention limit.
 *
 * **Export first, prune second, and that order is the decision** (ADR-0010).
 * Pruning before exporting destroys the only copy of a run, and there is no way
 * to notice until someone goes looking for it and it exists nowhere.
 *
 * It exports the **whole DO** rather than just this invocation's rows, because
 * pruning deletes from the whole DO. Exporting less than it prunes means a run
 * whose own export failed and was swallowed here sits unexported until some
 * later run's successful export prunes it away, losing it from both stores.
 * Doing both over the same set makes the invariant exact: prune only ever runs
 * once everything prunable is confirmed in D1. `pipelineId` is used **only** in
 * the error log below; the operation itself is DO-wide.
 *
 * `getSettledRows` is what keeps `running` rows out, and there is deliberately
 * no second filter here — two places to get it wrong is one too many.
 *
 * Never throws. It is called from inside `runPipeline`'s try *and* from its
 * catch, and a throw from a catch escapes the function. The run already
 * happened and the money is already spent; an export failure must not cost the
 * caller their result. The rows stay in the DO and the next invocation's export
 * sweeps them up, because export is idempotent.
 */
export async function exportAndPrune(
	db: IrisDb,
	env: Env,
	pipelineId: string,
	retentionLimit: number,
): Promise<void> {
	try {
		const rows = await getSettledRows(db);
		await exportRuns(getD1Db(env.DB), rows);
		// `retentionLimit` is the caller's argument and never `env.RETENTION_LIMIT`:
		// config is read once per request in `config.ts` and nowhere else (ADR-0008).
		await pruneCompletedRuns(db, retentionLimit);
	} catch (cause) {
		console.error(`d1 export failed for ${pipelineId}:`, describeError(cause));
	}
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
	// One object rather than six positional arguments, four of them adjacent
	// strings (AGENTS.md §6). Field order mirrors `db/schema.ts`.
	stage: {
		pipelineId: string;
		designSessionId: string;
		concept: string;
		motifRef: string;
		params: IrisParams;
		metadataExtras?: Record<string, unknown>;
	},
): Promise<ImageStageOutcome> {
	const { pipelineId, designSessionId, concept, motifRef, params, metadataExtras = {} } = stage;
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

	const seed = { pipelineId, designSessionId, userPrompt: concept, motifRef, plannerParams: params, modelMetadata };

	try {
		await startImageRun(db, seed);
		rowOpened = true;

		const image = await colorizeMotif(motifRef, params, config, env, pipelineId);
		costUsd = image.cost_usd;

		const imageR2Key = await saveColoredImage(env.PATTERNS, pipelineId, image.image, image.contentType);

		// Persisted here, not just returned: model_metadata is the only durable
		// home width/height have (there is no column and there deliberately never
		// will be one, iris-03 decision 9).
		await completeImageRun(db, {
			pipelineId,
			imageR2Key,
			costUsd,
			// Three pairs, answering different questions. `input_dimensions` and
			// `original_dimensions` are for debugging: when an output looks wrong the
			// first question is whether the input was mangled on the way in, and this
			// is the only place that answer survives. They are equal today because
			// there is no resize (iris-09 decision 3); both are recorded anyway so
			// the shape does not change the day one lands.
			//
			// `output_dimensions` is not debugging. It is the durable home of the
			// width and height `IrisResultSchema` promises Atlas, and `iris_runs` has
			// no column for them and deliberately never will (iris-03 decision 9).
			modelMetadata: {
				output_dimensions: { width: image.width, height: image.height },
				input_dimensions: image.inputDimensions,
				original_dimensions: image.inputDimensions,
			},
		});

		// Read back from what was just stored, rather than trusting `image.width`
		// and `image.height` directly, so a bug in the write path shows up here
		// instead of hiding until Atlas reads a pruned run.
		//
		// A missing row **throws** rather than degrading to nulls. This read-back
		// exists to catch a broken write path, and falling through to
		// `width: null, height: null` is how it caught nothing: Atlas would receive
		// a completed run with no dimensions and no indication anything was wrong
		// (AGENTS.md §7). Throwing here lands in the catch below and settles the
		// invocation as `failed`, with the stage named.
		const rows = await getRunRows(db, pipelineId);
		const imageRow = rows.find((row) => row.modality === "image");
		if (!imageRow) {
			throw new Error(`image row for pipeline_id ${pipelineId} vanished between writing and reading it back`);
		}
		const storedMetadata = (imageRow.modelMetadata ?? {}) as {
			output_dimensions?: { width?: unknown; height?: unknown };
		};
		const stored = storedMetadata.output_dimensions ?? {};

		return {
			ok: true,
			imageR2Key,
			costUsd,
			width: typeof stored.width === "number" ? stored.width : null,
			height: typeof stored.height === "number" ? stored.height : null,
		};
	} catch (cause) {
		if (!rowOpened) {
			// Its own try, and swallowed: the usual reason opening the row failed is
			// that DO storage is unavailable, in which case this write fails too.
			// Nothing can be recorded then, and `cause` is still the failure worth
			// reporting.
			try {
				await insertFailedImageRun(db, seed);
			} catch (rescueCause) {
				console.error(`could not record the unopened image row for ${pipelineId}:`, describeError(rescueCause));
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

	// The live planner prompt, read once for the same reason the config is: two
	// reads straddling an edit would produce one invocation running on half of
	// each. Outside the try because, like `resolveConfig`, it never throws — a
	// missing row, an unusable row and D1 being down all fall back to the
	// committed prompt rather than failing the request.
	const plannerPrompt = await resolvePrompt(getD1Db(env.DB), "iris_planner", buildPlannerSystemPrompt());
	console.log(describePrompt("iris_planner", plannerPrompt));

	// Identity of this pipeline invocation. Generated per invocation, NOT derived
	// from the Durable Object — one DO accumulates many invocations (ADR-0005).
	const pipelineId = crypto.randomUUID();

	let stage: Stage = "persist";
	let params: IrisParams | null = null;
	// Held outside the try because the image call bills before the R2 save and
	// the row update run. Without this, a failure in either records a spent
	// image as having cost nothing.
	let imageCost: number | null = null;

	try {
		// Inside the try so a storage failure is reported as a settled `failed`
		// result rather than escaping as an opaque 500.
		await startTextRun(db, {
			pipelineId,
			designSessionId: req.design_session_id,
			userPrompt: req.concept,
			motifRef: req.motif_ref,
			modelMetadata: { model: config.textModel.model },
		});

		stage = "planner";
		const planned = await planConcept(env, config, {
			concept: req.concept,
			systemPrompt: plannerPrompt.text,
			pipeline_id: pipelineId,
		});

		// Read here, not later: `aiGatewayLogId` holds the most recent routed call
		// on this binding, so the image stage would overwrite it.
		const plannerCost = await readGatewayCost(env, "planner");

		stage = "validate";
		params = IrisParamsSchema.parse(planned.data);

		// `model` comes from what the call reported, not from `config.textModel`:
		// a row naming the configured model rather than the one that answered is
		// the lying audit row ADR-0001 exists to prevent.
		const textModelMetadata = {
			model: planned.model,
			usage: planned.usage,
			// `prompt_version` identifies the *committed* prompt, so it is only the
			// truth when the committed prompt is what ran. A stored prompt can be
			// rewritten in the playground at any time and no id describes it, so
			// naming one here would be the lying audit row ADR-0001 exists to
			// prevent. `prompt_source` and `prompt_updated_at` are what stay
			// answerable: which store the words came from, and when they last
			// changed.
			prompt_version: plannerPrompt.source === "code" ? IRIS_PLANNER_PROMPT_VERSION : null,
			prompt_source: plannerPrompt.source,
			prompt_updated_at: plannerPrompt.updatedAt,
		};

		// Planner succeeded — settle the text row before the image row opens.
		await completeTextRun(db, pipelineId, params, textModelMetadata, plannerCost);

		stage = "image";
		const outcome = await runImageStage(db, env, config, {
			pipelineId,
			designSessionId: req.design_session_id,
			concept: req.concept,
			motifRef: req.motif_ref,
			params,
		});

		// Recorded before anything can throw, so the catch below reports what the
		// image actually cost rather than null.
		imageCost = outcome.costUsd;
		if (!outcome.ok) {
			throw outcome.cause;
		}

		await exportAndPrune(db, env, pipelineId, config.retentionLimit);

		return {
			pipeline_id: pipelineId,
			design_session_id: req.design_session_id,
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
			await failRunningRuns(db, pipelineId, imageCost);

			// Every invocation is two rows, whether it succeeded or not (ADR-0001).
			// A failure at "persist", "planner" or "validate" never reaches
			// `runImageStage`, so nothing has opened an image row yet — without
			// this, the invocation would settle as a single failed text row.
			if (stage === "persist" || stage === "planner" || stage === "validate") {
				await insertFailedImageRun(db, {
					pipelineId,
					designSessionId: req.design_session_id,
					userPrompt: req.concept,
					motifRef: req.motif_ref,
					// No cast: `RowSeed.plannerParams` admits `{}` because a run that
					// never reached the planner genuinely has none.
					plannerParams: params ?? {},
					modelMetadata: imageModelMetadata(config),
				});
			}
		} catch (cleanupCause) {
			console.error("could not mark rows failed:", describeError(cleanupCause));
		}

		await exportAndPrune(db, env, pipelineId, config.retentionLimit);

		return {
			pipeline_id: pipelineId,
			design_session_id: req.design_session_id,
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
