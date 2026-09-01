import type { HeliosDb } from "../db/client";
import { getD1Db } from "../db/client";
import { exportRuns } from "../repository/d1.repository";
import {
	HeliosParamsSchema,
	type HeliosParams,
	type HeliosRequest,
	type HeliosResult,
} from "@aureline/shared-types";
import { planConcept } from "./planner";
import { generateImage, resolveSteps } from "./imageGenerator";
import { savePatternImage } from "../repository/r2.repository";
import { describeError } from "../utils";
import { readGatewayCost } from "./gatewayCost";
import { describeConfig, describePrompt, resolveConfig, resolvePrompt, type HeliosConfig } from "../config";
import { buildPlannerSystemPrompt, PLANNER_PROMPT_ID } from "../prompts";
import {
	startTextRun,
	completeTextRun,
	startImageRun,
	insertFailedImageRun,
	completeImageRun,
	failRunningRuns,
	getSettledRows,
	pruneCompletedRuns,
} from "../repository/do.repository";

type Stage = "persist" | "planner" | "validate" | "image";

/**
 * What the image stage reports back to whoever called it.
 *
 * The cost rides on **both** branches deliberately. The model bills before the
 * R2 save and the row update run, so a caller that only learned the cost on
 * success would record a spent image as having cost nothing.
 */
type ImageStageOutcome =
	| { ok: true; imageR2Key: string; costUsd: number | null }
	| { ok: false; cause: unknown; costUsd: number | null };

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
		// What the call will actually send, not what KV holds — the two differ
		// whenever config carries a steps value above Flux's cap.
		steps: resolveSteps(config),
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
 * everything prunable is confirmed in D1.
 *
 * Never throws. Export is an audit concern, not something that should cost the
 * caller their result after they already waited on the pipeline.
 */
export async function exportAndPrune(
	db: HeliosDb,
	env: Env,
	pipeline_id: string,
	retentionLimit: number,
): Promise<void> {
	try {
		const rows = await getSettledRows(db);
		await exportRuns(getD1Db(env.DB), rows);
		await pruneCompletedRuns(db, retentionLimit);
	} catch (cause) {
		console.error(`d1 export failed for ${pipeline_id}:`, describeError(cause));
	}
}

/**
 * Everything from the image row opening to the image row settling: the row, the
 * model call, the R2 save, and the row update.
 *
 * It exists as its own function only so the resume route can enter the pipeline
 * here, with params read back from storage instead of from the planner. Keeping
 * one copy of the image path means a change to how images are made lands in one
 * place rather than two.
 *
 * **Builds no `HeliosResult`.** Both callers track their own `stage` and
 * `params` and shape their own result, so result building stays whole in one
 * place per caller instead of being split across two functions.
 *
 * Never throws. A failure comes back as `ok: false` carrying the cause, so the
 * caller decides what a failed image means for its own result.
 *
 * **Always leaves an image row behind.** If opening the row is what failed, one
 * is inserted already `failed`, so an invocation is two rows whether it
 * succeeded or not (ADR-0001). See `insertFailedImageRun` for what goes wrong
 * without it.
 *
 * `metadataExtras` is merged over the image row's model metadata. `runPipeline`
 * passes nothing; a resume passes its `resumed_from` and `attempt` markers,
 * which have to reach this row because it is the one carrying `cost_usd` and
 * `image_r2_key` and so the one every cost query reads (ticket 08, decision 15).
 */
export async function runImageStage(
	db: HeliosDb,
	env: Env,
	config: HeliosConfig,
	// One object rather than six positional arguments, three of them adjacent
	// strings (AGENTS.md §6). Field order mirrors `db/schema.ts`.
	stage: {
		pipelineId: string;
		designSessionId: string;
		concept: string;
		params: HeliosParams;
		metadataExtras?: Record<string, unknown>;
	},
): Promise<ImageStageOutcome> {
	const { pipelineId, designSessionId, concept, params, metadataExtras = {} } = stage;

	// Assigned the moment the model returns, so it is already set if the R2 save
	// or the row update throws after the call has billed.
	let costUsd: number | null = null;

	// Built once so the rescue insert below records the same model as the row
	// that was meant to open.
	const modelMetadata = { ...imageModelMetadata(config), ...metadataExtras };

	// Whether the image row exists. If opening it is what failed, the caller's
	// `failRunningRuns` has nothing to mark, and the invocation settles as a lone
	// `completed` text row: a failure that looks like a success and that
	// `pruneCompletedRuns` will delete like any other completed run.
	let rowOpened = false;

	try {
		await startImageRun(db, {
			pipelineId,
			designSessionId,
			userPrompt: concept,
			plannerParams: params,
			modelMetadata,
		});
		rowOpened = true;

		const image = await generateImage(params, config, env, pipelineId);
		costUsd = image.cost_usd;

		const imageR2Key = await savePatternImage(env.PATTERNS, pipelineId, image.image, image.contentType);

		await completeImageRun(db, { pipelineId, imageR2Key, costUsd });

		return { ok: true, imageR2Key, costUsd };
	} catch (cause) {
		if (!rowOpened) {
			// Its own try, and swallowed: the usual reason opening the row failed is
			// that DO storage is unavailable, in which case this write fails too.
			// Nothing can be recorded then, and `cause` is still the failure worth
			// reporting.
			try {
				await insertFailedImageRun(db, {
					pipelineId,
					designSessionId,
					userPrompt: concept,
					plannerParams: params,
					modelMetadata,
				});
			} catch (rescueCause) {
				console.error(`could not record the unopened image row for ${pipelineId}:`, describeError(rescueCause));
			}
		}

		return { ok: false, cause, costUsd };
	}
}

/**
 * Fixed-order orchestrator: planner → validate → image generator.
 *
 * Never throws. Every path — including a stage blowing up, or DO storage
 * itself being unavailable — returns a `HeliosResult`, so the HTTP layer only
 * has to deal with settled outcomes. The failing stage is prefixed onto
 * `error` so failures stay attributable without a separate field.
 */
export async function runPipeline(db: HeliosDb, req: HeliosRequest, env: Env, origin: string): Promise<HeliosResult> {
	// Read once per invocation so every stage sees the same snapshot. Reading
	// per-service instead would let two reads straddle a KV edit and produce a
	// `helios_runs` row that is half old model and half new (ADR-0001). Outside
	// the try because `resolveConfig` never throws.
	const config = await resolveConfig(env);
	console.log(describeConfig(config));

	// The live planner prompt, read once for the same reason the config is: two
	// reads straddling an edit would produce one invocation running on half of
	// each. Outside the try because, like `resolveConfig`, it never throws — a
	// missing row, an unusable row and D1 being down all fall back to the
	// committed prompt rather than failing the request.
	const plannerPrompt = await resolvePrompt(getD1Db(env.DB), "helios_planner", buildPlannerSystemPrompt());
	console.log(describePrompt("helios_planner", plannerPrompt));

	// Identity of this run of Helios. Generated per invocation, NOT derived from
	// the Durable Object — one DO accumulates many invocations (ADR-0005).
	const pipelineId = crypto.randomUUID();

	// The design, not this run. It arrives on the request and is never minted
	// here: a design id Helios invented would connect to nothing upstream or
	// down, which is the whole thing it exists to do (AGENTS.md §3).
	const designSessionId = req.design_session_id;

	let stage: Stage = "persist";
	let params: HeliosParams | null = null;
	// Held outside the try because the image call bills before the save and the
	// row update run. Without this, a failure in either records a spent image as
	// having cost nothing.
	let imageCost: number | null = null;

	try {
		// Inside the try so a storage failure is reported as a settled
		// `failed` result rather than escaping as an opaque 500.
		await startTextRun(db, {
			pipelineId,
			designSessionId,
			userPrompt: req.concept,
			modelMetadata: { model: config.textModel.model },
		});

		stage = "planner";
		const planned = await planConcept(env, config, {
			concept: req.concept,
			systemPrompt: plannerPrompt.text,
			pipeline_id: pipelineId,
		});

		// Read here, not later: `aiGatewayLogId` holds the most recent routed call
		// on this binding, so the image stage would overwrite it. Real dollars, so
		// `cost_usd` means the same thing on both rows. The provider's neuron
		// figure is not lost, it rides in `usage` on the metadata below.
		const textCostUsd = await readGatewayCost(env, "planner");

		stage = "validate";
		params = HeliosParamsSchema.parse(planned.data);

		const textModelMetadata = {
			model: planned.model,
			usage: planned.usage,
			// Which prompt actually ran. `prompt_version` identifies the *committed*
			// prompt, so it is only the truth when the committed prompt is what ran —
			// a stored prompt can be rewritten in the playground at any time and no
			// id describes it. Naming one anyway would be the lying audit row
			// ADR-0001 exists to prevent.
			prompt_version: plannerPrompt.source === "code" ? PLANNER_PROMPT_ID : null,
			prompt_source: plannerPrompt.source,
			prompt_updated_at: plannerPrompt.updatedAt,
		};

		// Planner succeeded — settle the text row before the image row opens.
		await completeTextRun(db, pipelineId, params, textModelMetadata, textCostUsd);

		stage = "image";
		const outcome = await runImageStage(db, env, config, {
			pipelineId,
			designSessionId,
			concept: req.concept,
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
			design_session_id: designSessionId,
			status: "completed",
			params,
			image_url: `${origin}/images/${outcome.imageR2Key}`,
			cost_usd: imageCost,
			error: null,
		};
	} catch (cause) {
		// Cleanup is itself a DO write, so it fails too when storage is what
		// broke — and a throw from inside a catch escapes the function. Swallow
		// it: `cause` is the failure worth reporting, this one is a symptom.
		try {
			await failRunningRuns(db, pipelineId, imageCost);
		} catch (cleanupCause) {
			console.error("could not mark rows failed:", describeError(cleanupCause));
		}

		await exportAndPrune(db, env, pipelineId, config.retentionLimit);

		return {
			pipeline_id: pipelineId,
			design_session_id: designSessionId,
			status: "failed",
			// Retained if the planner already produced valid params — partial state
			// is kept rather than discarded, so a failure stays inspectable.
			params,
			image_url: null,
			// Non-null only when the image was generated and something after it
			// broke. The money left the account either way, so it is reported.
			cost_usd: imageCost,
			error: `${stage}: ${describeError(cause)}`,
		};
	}
}
