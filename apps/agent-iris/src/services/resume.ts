import { IrisParamsSchema, type IrisResult } from "@aureline/shared-types";
import type { IrisDb } from "../db/client";
import type { IrisRun } from "../db/schema";
import {
	countResumeAttempts,
	failRunningRuns,
	getRunRows,
	insertResumedTextRun,
} from "../repository/do.repository";
import { readMotif } from "../repository/r2.repository";
import { describeConfig, resolveConfig } from "../config";
import { describeError, firstIssueMessage } from "../utils";
import { exportAndPrune, runImageStage } from "./pipeline";

/**
 * What a resume attempt reports back.
 *
 * A refusal is a precondition failure, not a run outcome: nothing was written
 * and nothing was billed, so there is no `pipeline_id` to report and it is not
 * an `IrisResult`. The HTTP layer turns it into a 409. A run that did happen
 * and then failed is a 200 carrying `status: "failed"`, same as `/generate`.
 */
export type ResumeOutcome = { ok: false; reason: string } | { ok: true; result: IrisResult };

/**
 * Re-runs the image half of an existing invocation using the params already on
 * disk, without calling the planner again.
 *
 * Its own file rather than a step inside `pipeline.ts` because it is a second
 * entry point into the pipeline, not a stage within one. It re-enters at
 * `runImageStage`, which is exported separately for exactly this.
 *
 * Every refusal below happens before a single row is written and before the
 * model is reachable, cheapest check first. That ordering is the point: a
 * refusal that has already spent money is not a refusal.
 */
export async function resumeRun(
	db: IrisDb,
	pipeline_id: string,
	env: Env,
	origin: string,
): Promise<ResumeOutcome> {
	const rows = await getRunRows(db, pipeline_id);

	if (rows.length === 0) {
		return { ok: false, reason: `no run ${pipeline_id} in this session` };
	}

	const textRow = rows.find((row) => row.modality === "text");
	if (!textRow || textRow.status !== "completed") {
		return {
			ok: false,
			reason: "the planner never succeeded for this run, so there are no params to reuse. Send a new POST /generate",
		};
	}

	// The money guards. Helios reads `imageRow?.status === "completed"` and
	// `imageRow?.status === "running"` here, and a row that is absent — or
	// present with `status` not where it is expected — matches neither, falls
	// straight through, and generates another image. That is the runaway loop
	// the Aug 20 DB bug meeting was about. So: `undefined` first, on its own,
	// then an exhaustive check on the status where the fall-through refuses
	// rather than continuing (AGENTS.md §7).
	const imageRow = rows.find((row) => row.modality === "image");
	if (imageRow === undefined) {
		return {
			ok: false,
			reason: `this run has no image row, so it is not a run that failed at the image stage. Resuming it would generate and charge for an image nobody asked for. Send a new POST /generate`,
		};
	}

	if (imageRow.status === "completed") {
		return {
			ok: false,
			reason: "this run already has an image, and resuming would generate and charge for a second one",
		};
	}

	if (imageRow.status === "running") {
		return {
			ok: false,
			reason: "this run's image is still being generated. Wait for it to settle before resuming",
		};
	}

	// `failed` is the only status left that is legal, and it is the one case
	// that proceeds. Anything else means the row is corrupted, which is a
	// different situation from the row being missing and gets a different
	// answer — refusing loudly rather than treating an unrecognised value as
	// permission to spend.
	if (imageRow.status !== "failed") {
		return {
			ok: false,
			reason: `this run's image row is corrupted: status is "${imageRow.status}", which is not a status this table can hold. Refusing rather than guessing what it meant`,
		};
	}

	// Read back as `unknown` from a JSON column, so they are re-validated rather
	// than trusted. They were valid when written; the colour vocabulary may have
	// changed since, and sending something malformed to a billed call is worse
	// than refusing.
	const parsed = IrisParamsSchema.safeParse(textRow.plannerParams);
	if (!parsed.success) {
		return { ok: false, reason: `the stored params are no longer valid: ${firstIssueMessage(parsed.error)}` };
	}
	const params = parsed.data;

	const config = await resolveConfig(env);
	console.log(describeConfig(config));

	const parent = parentMetadata(textRow);

	// The original this brief started from, inherited unchanged down the chain,
	// so every attempt at one brief shares it however deep or wide the retries
	// go. Absent on an original, and on any row written before `root` existed;
	// the parent's own id is correct for the first and starts a fresh count for
	// the second.
	const root = parent.root ?? pipeline_id;

	// Counted over `root` and never over `attempt`, which is depth: resuming the
	// same failed run ten times gives ten siblings all reading `attempt: 2`, and
	// a cap on depth would never fire. Never over `design_session_id` either —
	// one design session can hold several unrelated briefs (ADR-IRIS-0001).
	const alreadySpent = await countResumeAttempts(db, root);
	if (alreadySpent >= config.maxResumeAttempts) {
		return {
			ok: false,
			reason: `this brief has already been resumed ${alreadySpent} ${alreadySpent === 1 ? "time" : "times"}, the limit is ${config.maxResumeAttempts}. Send a new POST /generate if it is still worth pursuing`,
		};
	}

	// Last among the refusals because it is the only one that touches R2 or the
	// network, and there is no reason to pay for it if a cheaper check already
	// refuses. Iris-specific: the motif is another engine's output in another
	// engine's storage, so it is the failure most likely to actually happen.
	// Not retried — a missing motif is very rarely a network blip and very often
	// a key that was never written (ADR-IRIS-0001).
	try {
		await readMotif(env.PATTERNS, textRow.motifRef);
	} catch (cause) {
		return {
			ok: false,
			reason: `the motif for this run can no longer be read: ${describeError(cause)}. Resuming would fail at the same point after opening two rows`,
		};
	}

	// A new id, never the original. Each attempt is its own invocation with its
	// own two rows and its own cost, which is how "which attempt is the latest"
	// stays answerable (AGENTS.md §3).
	const newPipelineId = crypto.randomUUID();

	// `resumed_from` points at the immediate parent, not the root, so a resume
	// of a resume reads back as one more step rather than a fork. `root` is what
	// makes counting one query instead of a walk back up the chain.
	const marker = { root, resumed_from: pipeline_id, attempt: parent.attempt + 1 };

	// Held outside the try for the same reason `runPipeline` holds it: the image
	// call bills before the R2 save and the row update, so a failure in either
	// would otherwise record a spent image as having cost nothing.
	let imageCost: number | null = null;

	// Inherited from the parent, never minted. A resume is another attempt at
	// the same design, and an engine that mints its own here breaks the chain
	// for everything downstream (AGENTS.md §3).
	const designSessionId = textRow.designSessionId;

	try {
		await insertResumedTextRun(db, {
			pipelineId: newPipelineId,
			designSessionId,
			userPrompt: textRow.userPrompt,
			motifRef: textRow.motifRef,
			plannerParams: params,
			modelMetadata: {
				// The model that actually produced these params, carried over from
				// the parent. Naming the currently configured planner instead would
				// credit a model that was never called for this row.
				model: parent.model ?? config.textModel.model,
				...marker,
				planner_skipped: true,
			},
		});

		// The markers reach the image row through `metadataExtras`. That row is
		// the one carrying `cost_usd` and `image_r2_key`, so it is the row every
		// cost query reads; markers on the text row alone would make a brief
		// resumed four times report as four unrelated runs.
		const outcome = await runImageStage(db, env, config, {
			pipelineId: newPipelineId,
			designSessionId,
			concept: textRow.userPrompt,
			motifRef: textRow.motifRef,
			params,
			metadataExtras: marker,
		});

		imageCost = outcome.costUsd;
		if (!outcome.ok) {
			throw outcome.cause;
		}

		await exportAndPrune(db, env, newPipelineId, config.retentionLimit);

		return {
			ok: true,
			result: {
				pipeline_id: newPipelineId,
				design_session_id: designSessionId,
				status: "completed",
				params,
				image_url: `${origin}/images/${outcome.imageR2Key}`,
				width: outcome.width,
				height: outcome.height,
				cost_usd: imageCost,
				error: null,
			},
		};
	} catch (cause) {
		// Only the image row is ever `running` here — the text row went in
		// already settled. Wrapped in its own try because when storage is what
		// broke, this write breaks too, and a throw from inside a catch escapes
		// the function.
		try {
			await failRunningRuns(db, newPipelineId, imageCost);
		} catch (cleanupCause) {
			console.error("could not mark rows failed:", describeError(cleanupCause));
		}

		await exportAndPrune(db, env, newPipelineId, config.retentionLimit);

		return {
			ok: true,
			result: {
				pipeline_id: newPipelineId,
				design_session_id: designSessionId,
				status: "failed",
				// Kept, not nulled. The params are what made this run resumable in
				// the first place, and a failed resume is itself resumable.
				params,
				image_url: null,
				width: null,
				height: null,
				cost_usd: imageCost,
				// The image stage is the only stage a resume has, so there is
				// nothing to track and the prefix is fixed.
				error: `image: ${describeError(cause)}`,
			},
		};
	}
}

/**
 * The three fields a resume reads off its parent's text row.
 *
 * `model_metadata` is a JSON column typed `unknown`, so each field is narrowed
 * on its own rather than cast as a block: a corrupted `attempt` should fall
 * back to the default without taking `root` down with it, and `root` is what
 * the spend cap counts.
 */
function parentMetadata(textRow: IrisRun): {
	model: string | undefined;
	attempt: number;
	root: string | undefined;
} {
	const metadata: Record<string, unknown> =
		typeof textRow.modelMetadata === "object" && textRow.modelMetadata !== null
			? { ...textRow.modelMetadata }
			: {};

	return {
		model: typeof metadata.model === "string" ? metadata.model : undefined,
		// Depth from the original. An original carries none, and is depth 1.
		attempt: typeof metadata.attempt === "number" ? metadata.attempt : 1,
		// Absent on an original, and on any run written before `root` existed.
		// The caller falls back to the parent's own id, which is correct for an
		// original and starts a fresh count for a legacy chain.
		root: typeof metadata.root === "string" ? metadata.root : undefined,
	};
}
