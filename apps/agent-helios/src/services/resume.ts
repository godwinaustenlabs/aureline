import { HeliosParamsSchema, type HeliosResult } from "@aureline/shared-types";
import type { HeliosDb } from "../db/client";
import type { HeliosRun } from "../db/schema";
import {
	countResumeAttempts,
	failRunningRuns,
	getRunRows,
	insertResumedTextRun,
} from "../repository/do.repository";
import { describeConfig, resolveConfig } from "../config";
import { describeError, firstIssueMessage } from "../utils";
import { exportAndPrune, runImageStage } from "./pipeline";

/**
 * Either the route refused before doing anything, or a run happened and settled.
 *
 * A refusal is a precondition failure, not a run outcome: nothing was written
 * and nothing was billed, so there is no `p_invoc_id` to report and it is not a
 * `HeliosResult`. The HTTP layer turns it into a 409. Everything past the first
 * write comes back as `ok: true` carrying a settled `HeliosResult`, success or
 * failure alike, exactly like `runPipeline`.
 */
export type ResumeOutcome = { ok: false; reason: string } | { ok: true; result: HeliosResult };

/**
 * Runs the image half of an existing invocation again, from the params already
 * on disk. The planner is never called.
 *
 * This is the image stage's retry, and it is manual on purpose: a failed image
 * call usually fails again for the same reason and every attempt spends the
 * expensive model, so a person decides rather than a loop (ticket 08, decision 2).
 *
 * The resumed run is a new invocation with its own `p_invoc_id` and its own two
 * rows. The original is left exactly as it was, because the failure record is
 * the thing ticket 08 exists to preserve.
 *
 * Never throws.
 */
export async function resumeRun(
	db: HeliosDb,
	p_invoc_id: string,
	env: Env,
	origin: string,
): Promise<ResumeOutcome> {
	const rows = await getRunRows(db, p_invoc_id);

	// Five separate refusals rather than one generic error. They mean genuinely
	// different things to whoever is holding the failed run, and the fourth is the
	// one standing between us and paying for the same image twice.
	if (rows.length === 0) {
		return { ok: false, reason: `no run ${p_invoc_id} in this session` };
	}

	const textRow = rows.find((row) => row.modality === "text");
	if (!textRow || textRow.status !== "completed") {
		return {
			ok: false,
			reason: "the planner never succeeded for this run, so there are no params to reuse. Send a new POST /generate",
		};
	}

	const imageRow = rows.find((row) => row.modality === "image");

	// `undefined` before any status is read, because the two guards below use
	// `?.` and a missing row matches neither of them. Without this, a run with no
	// image row falls straight through into generating and billing another image
	// (AGENTS.md §7) — the shape that produced the runaway loop this engine is
	// named for in that section.
	//
	// It is reachable: `runImageStage` rescues a never-opened image row with
	// `insertFailedImageRun`, and that rescue has its own catch. When it is the
	// thing that broke, the invocation settles as a lone text row and ADR-0001's
	// two-rows invariant has been violated by a lost write. Refusing is the
	// cheap answer — the run's own metadata is what a resume reads its attempt
	// count from, and that is exactly what cannot be trusted here.
	if (!imageRow) {
		return {
			ok: false,
			reason:
				"this run has no image row at all, so its record is incomplete and resuming would build on a run whose state was never written. Send a new POST /generate",
		};
	}

	if (imageRow.status === "completed") {
		return { ok: false, reason: "this run already has an image, and resuming would generate and charge for a second one" };
	}
	if (imageRow.status === "running") {
		return { ok: false, reason: "this run's image is still being generated. Wait for it to settle before resuming" };
	}

	// Read back as `unknown` from a JSON column, so they are re-validated rather
	// than trusted. A row written under an older schema has to refuse loudly here
	// instead of quietly producing a nonsense image.
	const parsed = HeliosParamsSchema.safeParse(textRow.plannerParams);
	if (!parsed.success) {
		return { ok: false, reason: `the stored params are no longer valid: ${firstIssueMessage(parsed.error)}` };
	}
	const params = parsed.data;

	const config = await resolveConfig(env);
	console.log(describeConfig(config));

	const parent = parentMetadata(textRow);

	// The original this brief started from. Inherited unchanged down the chain, so
	// every attempt at one concept shares it however deep or wide the retries go.
	const root = parent.root ?? p_invoc_id;

	// The money guard. `attempt` cannot do this job: it is depth from the
	// original, so resuming the same failed run ten times gives ten siblings all
	// reading `attempt: 2` and a cap on it would never bite. Counting by root
	// counts what was actually spent on this concept.
	const alreadySpent = await countResumeAttempts(db, root);
	if (alreadySpent >= config.maxResumeAttempts) {
		return {
			ok: false,
			reason: `this brief has already been resumed ${alreadySpent} ${alreadySpent === 1 ? "time" : "times"}, the limit is ${config.maxResumeAttempts}. Send a new POST /generate if it is still worth pursuing`,
		};
	}

	const newInvocId = crypto.randomUUID();

	// `resumed_from` points at the immediate parent, not the root, so a resume of
	// a resume reads back as one more step rather than a fork. `root` is what
	// makes counting one query instead of a walk back up the chain.
	const marker = { root, resumed_from: p_invoc_id, attempt: parent.attempt + 1 };

	// Held outside the try for the same reason `runPipeline` holds it: the image
	// call bills before the R2 save and the row update, so a failure in either
	// would otherwise record a spent image as having cost nothing.
	let imageCost: number | null = null;

	try {
		await insertResumedTextRun(db, newInvocId, textRow.userPrompt, params, {
			// The model that actually produced these params, carried over from the
			// parent. Naming the currently configured planner instead would credit a
			// model that was never called for this row.
			model: parent.model ?? config.textModel.model,
			...marker,
			planner_skipped: true,
		});

		const outcome = await runImageStage(db, env, config, newInvocId, textRow.userPrompt, params, marker);

		imageCost = outcome.costUsd;
		if (!outcome.ok) {
			throw outcome.cause;
		}

		await exportAndPrune(db, env, newInvocId, config.retentionLimit);

		return {
			ok: true,
			result: {
				p_invoc_id: newInvocId,
				status: "completed",
				params,
				image_url: `${origin}/images/${outcome.imageR2Key}`,
				cost_usd: imageCost,
				error: null,
			},
		};
	} catch (cause) {
		// Only the image row is ever `running` here — the text row went in already
		// settled. Wrapped in its own try because when storage is what broke, this
		// write breaks too, and a throw from inside a catch escapes the function.
		try {
			await failRunningRuns(db, newInvocId, imageCost);
		} catch (cleanupCause) {
			console.error("could not mark rows failed:", describeError(cleanupCause));
		}

		await exportAndPrune(db, env, newInvocId, config.retentionLimit);

		return {
			ok: true,
			result: {
				p_invoc_id: newInvocId,
				status: "failed",
				// Kept, not nulled. The params are what made this run resumable in the
				// first place, and a failed resume is itself resumable.
				params,
				image_url: null,
				cost_usd: imageCost,
				// The image stage is the only stage a resume has, so there is nothing
				// to track and the prefix is fixed.
				error: `image: ${describeError(cause)}`,
			},
		};
	}
}

/**
 * The parent's model and attempt number out of its `model_metadata` JSON column,
 * which reads back as `unknown` and so is trusted for nothing.
 *
 * An original run carries no `attempt`, which is what makes it an original: it
 * counts as attempt 1, so the first resume is attempt 2.
 */
function parentMetadata(textRow: HeliosRun): {
	model: string | undefined;
	attempt: number;
	root: string | undefined;
} {
	const metadata = (textRow.modelMetadata ?? {}) as {
		model?: unknown;
		attempt?: unknown;
		root?: unknown;
	};

	return {
		model: typeof metadata.model === "string" ? metadata.model : undefined,
		attempt: typeof metadata.attempt === "number" ? metadata.attempt : 1,
		// Absent on an original, and on any run written before the root existed.
		// The caller falls back to the parent's own id, which is correct for an
		// original and starts a fresh count for a legacy chain.
		root: typeof metadata.root === "string" ? metadata.root : undefined,
	};
}
