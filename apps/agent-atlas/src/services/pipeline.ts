import {
	AtlasPlacementSchema,
	type AtlasPlacement,
	type AtlasRequest,
	type AtlasResult,
} from "@aureline/shared-types";
import type { AtlasDb } from "../db/client";
import { getD1Db } from "../db/client";
import { exportRuns } from "../repository/d1.repository";
import {
	startRun,
	completeRun,
	type RowSeed,
	insertFailedRun,
	failRunningRuns,
	getSettledRows,
	pruneCompletedRuns,
} from "../repository/do.repository";
import { saveGarmentImage } from "../repository/r2.repository";
import { placePattern } from "./placer";
import { PLACEMENT_PROMPT_VERSION, validRegionsFor } from "../prompts/placement.prompt";
import { describeConfig, resolveConfig, type AtlasConfig } from "../config";
import { describeError } from "../utils";

/**
 * Fixed-order orchestrator: validate, then image.
 *
 * **There is no planner stage.** Atlas has one billable call and no text model
 * (ADR-ATLAS-0001). Validation still gets to be its own step, because
 * `validRegionsFor` can reject a request before anything bills, and an
 * impossible request should never reach a paid call.
 */

type Stage = "persist" | "validate" | "image";

/**
 * What the image stage reports back to whoever called it.
 *
 * The cost rides on **both** branches deliberately. The model bills before the
 * R2 save and the row update run, so a caller that only learned the cost on
 * success would record a spent image as having cost nothing.
 */
type ImageStageOutcome =
	| { ok: true; imageR2Key: string; width: number; height: number; costUsd: number | null }
	| { ok: false; cause: unknown; costUsd: number | null };

/**
 * The row's metadata, built from the config the run will actually use rather
 * than from literals — a hardcoded model name here would record a model that
 * was never called once `image_model` is changed in KV.
 */
function imageModelMetadata(config: AtlasConfig) {
	return {
		model: config.imageModel.model,
		steps: config.imageModel.steps ?? null,
	};
}

/**
 * Copies every settled row in this DO into D1, then prunes the DO down to the
 * retention limit — but only if the export succeeded.
 *
 * It exports the whole DO rather than just this invocation because pruning
 * deletes from the whole DO. Exporting less than it prunes means a run whose
 * own export failed and was swallowed here sits unexported until some later
 * run's successful export prunes it away, losing it from both stores. Doing
 * both over the same set makes the invariant exact: prune only ever runs once
 * everything prunable is confirmed in D1 (ADR-0010).
 *
 * Never throws. Export is an audit concern, not something that should cost the
 * caller their result after they already waited on the pipeline. The rows stay
 * in the DO and the next invocation's export picks them up, because export is
 * idempotent.
 */
export async function exportAndPrune(
	db: AtlasDb,
	env: Env,
	pipeline_id: string,
	retentionLimit: number,
): Promise<void> {
	// Hoisted so the failure log can say how much is now stuck in the DO.
	let settled = 0;

	try {
		const rows = await getSettledRows(db);
		settled = rows.length;
		await exportRuns(getD1Db(env.DB), rows);
		await pruneCompletedRuns(db, retentionLimit);
	} catch (cause) {
		// Swallowed on purpose (ADR-0010), but the consequence is named: prune
		// only runs after a successful export, so every failure leaves the DO one
		// invocation larger. A transient failure is picked up by the next run's
		// export. A persistent one — a misconfigured D1 binding, a missing
		// migration — means the DO grows without bound and nothing else says so.
		// If this line repeats with a rising count, that is the signal.
		console.error(
			`d1 export failed for ${pipeline_id}: ${describeError(cause)}. ` +
				`${settled} settled row(s) remain unexported and unpruned in this Durable Object; ` +
				`it will keep growing until an export succeeds.`,
		);
	}
}

/**
 * What one placement run is working on.
 *
 * **One object, not four adjacent strings.** Nothing in the type system tells
 * one string parameter from another at a call site, so a swapped pair here
 * would compile, run, and write the garment URL into `pattern_ref`. Field order
 * matches `RowSeed` and the schema, so a call site reads rather than counts.
 */
export type PlacementRun = Omit<RowSeed, "modelMetadata">;

/**
 * Everything from the row opening to the row settling: the row, the placement
 * call, the R2 save, and the row update.
 *
 * **Exported separately from `runPipeline` from day one**, so atlas-08's
 * `/resume` can re-enter the pipeline here with a placement read back from
 * storage. Atlas has one stage and inlining this reads better and is fewer
 * lines — and it would make resume impossible without refactoring the only code
 * path in the engine. Do not inline it.
 *
 * **Builds no `AtlasResult`.** Both callers track their own stage and shape
 * their own result, so result building stays whole in one place per caller.
 *
 * Never throws. A failure comes back as `ok: false` carrying the cause, so the
 * caller decides what a failed image means for its own result.
 *
 * **Always leaves a row behind.** If opening the row is what failed, one is
 * inserted already `failed`. Atlas has one row per invocation, so without that
 * rescue a failed invocation leaves no trace at all.
 *
 * `metadataExtras` is merged over the row's metadata. `runPipeline` passes
 * nothing; a resume passes its `root`, `resumed_from` and `attempt` markers,
 * which have to reach this row because it is the only row there is.
 */
export async function runImageStage(
	db: AtlasDb,
	env: Env,
	config: AtlasConfig,
	run: PlacementRun,
	metadataExtras: Record<string, unknown> = {},
): Promise<ImageStageOutcome> {
	const { pipelineId, designSessionId, patternRef, garmentRef, placement } = run;
	// Assigned the moment the call returns, so it is already set if the R2 save
	// or the row update throws after the call has billed.
	let costUsd: number | null = null;

	// Built once so the rescue insert below records the same model as the row
	// that was meant to open.
	const modelMetadata = { ...imageModelMetadata(config), ...metadataExtras };

	// Whether the row exists. If opening it is what failed, the caller's
	// `failRunningRuns` has nothing to mark and the invocation vanishes.
	let rowOpened = false;

	try {
		await startRun(db, { ...run, modelMetadata });
		rowOpened = true;

		const output = await placePattern(patternRef, garmentRef, placement, config, env, pipelineId);
		costUsd = output.cost_usd;

		const imageR2Key = await saveGarmentImage(env.PATTERNS, pipelineId, output.image, output.contentType);

		await completeRun(db, pipelineId, imageR2Key, costUsd, modelMetadata);

		return { ok: true, imageR2Key, width: output.width, height: output.height, costUsd };
	} catch (cause) {
		if (!rowOpened) {
			// Its own try, and swallowed: the usual reason opening the row failed is
			// that DO storage is unavailable, in which case this write fails too.
			// Nothing can be recorded then, and `cause` is still the failure worth
			// reporting.
			try {
				await insertFailedRun(db, { ...run, modelMetadata });
			} catch (rescueCause) {
				console.error(`could not record the unopened row for ${pipelineId}:`, describeError(rescueCause));
			}
		}

		return { ok: false, cause, costUsd };
	}
}

/**
 * Runs one Atlas invocation.
 *
 * **Never throws.** Every path — including a stage blowing up, or DO storage
 * itself being unavailable — returns an `AtlasResult`, so the HTTP layer only
 * has to deal with settled outcomes and never has to produce a 500. The failing
 * stage is prefixed onto `error` so failures stay attributable without a
 * separate column, which is why `atlas_runs` has no `error` column.
 */
export async function runPipeline(
	db: AtlasDb,
	req: AtlasRequest,
	env: Env,
	origin: string,
): Promise<AtlasResult> {
	// Read once per invocation so every stage sees the same snapshot (ADR-0008).
	// Outside the try because `resolveConfig` never throws.
	const config = await resolveConfig(env);
	console.log(describeConfig(config));

	// Identity of this pipeline invocation. Generated per invocation, NOT derived
	// from the Durable Object — one DO accumulates many invocations (ADR-0005).
	const pipeline_id = crypto.randomUUID();

	let stage: Stage = "persist";
	let placement: AtlasPlacement | null = null;
	// Held outside the try because the image call bills before the save and the
	// row update run. Without this, a failure in either records a spent image as
	// having cost nothing, and it is invisible until it happens in production.
	let imageCost: number | null = null;

	try {
		stage = "validate";

		// Before anything bills. A sleeve on a scarf is a request the model cannot
		// satisfy, and asking anyway degrades the output rather than being ignored.
		const { valid, rejected } = validRegionsFor(req.garment_type, req.regions);
		if (rejected.length > 0) {
			throw new Error(
				`a ${req.garment_type} has no ${rejected.join(" or ")}. Valid regions for it are: ${valid.length ? valid.join(", ") : "none of the ones requested"}.`,
			);
		}

		// What this run actually did, recorded on the row. Parsed rather than cast,
		// so a placement that could never be read back is caught before it is
		// written rather than at resume time.
		placement = AtlasPlacementSchema.parse({
			garment_type: req.garment_type,
			regions: valid,
			coverage: req.coverage,
			pattern_scale: req.pattern_scale,
			prompt_version: PLACEMENT_PROMPT_VERSION,
		});

		stage = "image";
		const outcome = await runImageStage(db, env, config, {
			pipelineId: pipeline_id,
			designSessionId: req.design_session_id,
			patternRef: req.pattern_ref,
			garmentRef: req.garment_ref,
			placement,
		});

		// Recorded before anything can throw, so the catch below reports what the
		// image actually cost rather than null.
		imageCost = outcome.costUsd;
		if (!outcome.ok) {
			throw outcome.cause;
		}

		await exportAndPrune(db, env, pipeline_id, config.retentionLimit);

		return {
			pipeline_id,
			design_session_id: req.design_session_id,
			status: "completed",
			placement,
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
			await failRunningRuns(db, pipeline_id, imageCost);
		} catch (cleanupCause) {
			console.error("could not mark rows failed:", describeError(cleanupCause));
		}

		await exportAndPrune(db, env, pipeline_id, config.retentionLimit);

		return {
			pipeline_id,
			design_session_id: req.design_session_id,
			status: "failed",
			// Retained if validation already produced one — partial state is kept
			// rather than discarded, so a failure stays inspectable and resumable.
			placement,
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
