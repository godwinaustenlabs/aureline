import type { HeliosDb } from "../db/client";
import { getD1Db } from "../db/client";
import { exportRuns } from "../repository/d1.repository";
import {
	HeliosParamsSchema,
	type HeliosParams,
	type HeliosRequest,
	type HeliosResult,
	type Classification,
	type ReferenceImage,
} from "@aureline/shared-types";
import { planConcept } from "./planner";
import { classifyConcept } from "./classifier";
import { runResearch } from "./research";
import { generateImage, resolveSteps, type ImageCallRecord } from "./imageGenerator";
import { savePatternImage } from "../repository/r2.repository";
import { describeError } from "../utils";
import { readGatewayCost } from "./gatewayCost";
import { describeConfig, describePrompt, resolveConfig, resolvePrompt, transportFor, type HeliosConfig } from "../config";
import {
	buildClassifierSystemPrompt,
	buildPlannerConstraints,
	buildPlannerSystemPrompt,
	buildResearchSystemPrompt,
	HELIOS_CLASSIFIER_PROMPT_VERSION,
	HELIOS_RESEARCH_PROMPT_VERSION,
	PLANNER_PROMPT_ID,
} from "../prompts";
import {
	startTextRun,
	recordClassification,
	completeTextRun,
	startImageRun,
	insertFailedImageRun,
	completeImageRun,
	failRunningRuns,
	getSettledRows,
	pruneCompletedRuns,
} from "../repository/do.repository";

/**
 * `classify` and `research` sit between `persist` and `planner`, in that order,
 * and the order is load-bearing for cost rather than for correctness: classify
 * is gated and research is not, so research runs *between* two gated calls and
 * never sets `aiGatewayLogId` (ADR-SHARED-0005).
 *
 * Each name becomes a user-visible error prefix via the catch below.
 */
type Stage = "persist" | "classify" | "research" | "planner" | "validate" | "image";

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
 * The image row's metadata **as best it can be known before the call**.
 *
 * The row has to be opened before the model is called — that is what makes a
 * failed image a recorded failure rather than a missing row (ADR-0001) — so this
 * is necessarily a prediction. It is built from the config the run will use
 * rather than from literals, because a hardcoded model name would record a model
 * that was never called once `image_model` changes in KV.
 *
 * **It is overwritten with the truth once the call returns**, by
 * `recordedCall` below. That matters more than it used to: which model runs now
 * depends on whether the request carried a reference image, so this prediction
 * is wrong for exactly the runs the new work is about, and a row left holding it
 * would name flux-1-schnell for a call to klein.
 *
 * `hasReferenceImage` is passed rather than inferred so that even the row opened
 * for a call that then failed names the model that was actually attempted.
 */
function imageModelMetadata(config: HeliosConfig, hasReferenceImage: boolean) {
	// Never throws here: `imageModelFor` refuses when a reference arrives with no
	// model configured, and that refusal has to reach the caller as a failed run
	// rather than an unopened row.
	const model = hasReferenceImage ? config.imageToImageModel : config.imageModel;

	return {
		model: model.model,
		transport: transportFor(model),
		// Only meaningful on the JSON path; the multipart call sends no steps and a
		// row claiming one would describe a parameter the model never saw.
		...(transportFor(model) === "json" && { steps: resolveSteps(config) }),
		reference_image_sent: hasReferenceImage,
	};
}

/**
 * The image row's metadata as the call actually happened.
 *
 * Everything `imageModelMetadata` could only guess at, now known: which model
 * answered, over which transport, with what sent to it. This is what the audit
 * row keeps.
 */
function recordedCall(call: ImageCallRecord) {
	return {
		model: call.model,
		transport: call.transport,
		...(call.steps !== undefined && { steps: call.steps }),
		reference_image_sent: call.referenceImageSent,
		// Null whenever the bytes were not a readable JPEG — a PNG upload, most
		// likely. The warning is in the log; the null is here so the row does not
		// imply a size nobody measured.
		reference_dimensions: call.referenceDimensions,
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
		/**
		 * The classifier's answer, duplicated onto the image row.
		 *
		 * Both rows of an invocation carry it for the same reason both carry
		 * `planner_params` (ADR-0001): anything reading one row should not need a
		 * join to the other. Optional because `/resume` re-runs the image stage
		 * without re-classifying, and the column's `{}` default is the honest
		 * value there.
		 */
		classification?: Classification | Record<string, never>;
		/**
		 * The user's reference image, when this invocation carried one.
		 *
		 * Optional, and `/resume` simply omits it — the image is transient and was
		 * never persisted, so a resumed run has none and behaves exactly as it
		 * always did (ADR-SHARED-0003). Nothing about resume had to change for
		 * this to be true, which is the reason it is shaped this way.
		 */
		referenceImage?: ReferenceImage;
		metadataExtras?: Record<string, unknown>;
	},
): Promise<ImageStageOutcome> {
	const { pipelineId, designSessionId, concept, params, classification, referenceImage, metadataExtras = {} } = stage;

	// Assigned the moment the model returns, so it is already set if the R2 save
	// or the row update throws after the call has billed.
	let costUsd: number | null = null;

	// Built once so the rescue insert below records the same model as the row
	// that was meant to open. A prediction until the call returns — see
	// `imageModelMetadata`.
	const modelMetadata = { ...imageModelMetadata(config, referenceImage !== undefined), ...metadataExtras };

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
			...(classification !== undefined && { classification }),
		});
		rowOpened = true;

		const image = await generateImage(params, config, env, pipelineId, referenceImage);
		costUsd = image.cost_usd;

		const imageR2Key = await savePatternImage(env.PATTERNS, pipelineId, image.image, image.contentType);

		// The predicted metadata is replaced with what the call actually did.
		// `metadataExtras` is re-applied on top so a resume's markers survive.
		await completeImageRun(db, {
			pipelineId,
			imageR2Key,
			costUsd,
			modelMetadata: { ...recordedCall(image.call), ...metadataExtras },
		});

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
	const d1 = getD1Db(env.DB);
	const plannerPrompt = await resolvePrompt(d1, "helios_planner", buildPlannerSystemPrompt());
	console.log(describePrompt("helios_planner", plannerPrompt));

	// The other two, read the same way and for the same reason. `resolvePrompt`
	// never throws, so a missing row or a D1 outage falls back to the committed
	// text rather than failing a request that could have run.
	const classifierPrompt = await resolvePrompt(d1, "helios_classifier", buildClassifierSystemPrompt());
	console.log(describePrompt("helios_classifier", classifierPrompt));

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

		stage = "classify";
		const classified = await classifyConcept(env, config, {
			concept: req.concept,
			systemPrompt: classifierPrompt.text,
			pipeline_id: pipelineId,
			image: req.image,
		});

		// Read immediately, before the ungated research call. An ungated call does
		// not clear `aiGatewayLogId`, so this is the only moment the classifier's
		// cost is unambiguously its own (ADR-SHARED-0005).
		const classifyCostUsd = await readGatewayCost(env, "classify");

		// Written now rather than at `completeTextRun`, so a run that fails at
		// research or planner still records what kind of design it thought it was
		// making.
		await recordClassification(db, pipelineId, classified.data);

		stage = "research";
		// The research prompt is resolved here, not with the others above, because
		// its code fallback takes the classification — which does not exist until
		// the line above. A stored row ignores the argument, which is exactly why
		// `buildResearchUserPrompt` carries the classification in the user turn.
		const researchPrompt = await resolvePrompt(
			d1,
			"helios_research",
			buildResearchSystemPrompt(classified.data),
		);
		console.log(describePrompt("helios_research", researchPrompt));

		const research = await runResearch(env, config, {
			concept: req.concept,
			classification: classified.data,
			systemPrompt: researchPrompt.text,
			pipeline_id: pipelineId,
			image: req.image,
		});
		// No cost read here. The research call is ungated by decision, and reading
		// one would return the classifier's cost and file it under research
		// (ADR-SHARED-0005). `readGatewayCost`'s `stage` parameter is typed
		// `"planner" | "image"` precisely so this is a compile error, not a habit.

		stage = "planner";
		const planned = await planConcept(env, config, {
			concept: req.concept,
			systemPrompt: plannerPrompt.text,
			pipeline_id: pipelineId,
			image: req.image,
			// The classifier's answer and whatever research retrieved, composed into
			// the slot the planner prompt has held open since Sprint 1.
			constraints: buildPlannerConstraints(classified.data, research.context),
		});

		// Read here, not later: `aiGatewayLogId` holds the most recent routed call
		// on this binding, so the image stage would overwrite it. Real dollars, so
		// `cost_usd` means the same thing on both rows. The provider's neuron
		// figure is not lost, it rides in `usage` on the metadata below.
		const plannerCostUsd = await readGatewayCost(env, "planner");

		// Two gated calls, so the text row's single cost column holds their sum.
		// `null` is not zero (ADR-0007), so a missing figure must not silently
		// contribute 0 to a total that then reads as complete: the sum is null
		// unless at least one side reported, and it adds only what did.
		const textCostUsd =
			classifyCostUsd === null && plannerCostUsd === null
				? null
				: (classifyCostUsd ?? 0) + (plannerCostUsd ?? 0);

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
			/**
			 * The classify call, recorded beside the planner's rather than replacing
			 * it. Both are real model calls on this row and `cost_usd` is their sum,
			 * so a reader who cannot see the split cannot check the total.
			 */
			classifier: {
				model: classified.model,
				usage: classified.usage,
				prompt_version:
					classifierPrompt.source === "code" ? HELIOS_CLASSIFIER_PROMPT_VERSION : null,
				prompt_source: classifierPrompt.source,
				prompt_updated_at: classifierPrompt.updatedAt,
				cost_usd: classifyCostUsd,
			},
			/**
			 * What retrieval did, including when it did nothing.
			 *
			 * `enabled: false` (switched off), `quality: "none"` (the model chose
			 * not to search) and `quality: "thin"` (it searched and found little)
			 * are three different runs that would otherwise be indistinguishable
			 * from a completed row. `cost_usd` is always null here and never 0 —
			 * the call is ungated by decision, so several billed calls went
			 * unmeasured, which is not the same as free.
			 */
			retrieval: research.metadata,
			research_prompt_version:
				researchPrompt.source === "code" ? HELIOS_RESEARCH_PROMPT_VERSION : null,
			research_prompt_source: researchPrompt.source,
			/**
			 * Whether a reference image reached the planner on this run.
			 *
			 * The image itself is transient and is never stored, so this flag is
			 * the only durable trace it existed. It is what keeps "why does this
			 * run look different from that one" answerable from the audit table
			 * alone — including after a `/resume`, which re-runs the image stage
			 * from these stored params and never sees an image at all.
			 */
			had_reference_image: req.image !== undefined,
		};

		// Planner succeeded — settle the text row before the image row opens.
		await completeTextRun(db, pipelineId, params, textModelMetadata, textCostUsd);

		stage = "image";
		const outcome = await runImageStage(db, env, config, {
			pipelineId,
			designSessionId,
			concept: req.concept,
			params,
			classification: classified.data,
			// The same image the planner saw. It now reaches the image model too,
			// which is the point of ADR-SHARED-0003's successor: the picture used to
			// influence the pixels only through the words the planner wrote about it.
			referenceImage: req.image,
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
