import { and, eq } from "drizzle-orm";
import type { HeliosParams } from "@aureline/shared-types";
import type { HeliosDb } from "../db/client";
import { heliosRuns, type NewHeliosRun } from "../db/schema";

/**
 * Every write against `helios_runs` in this Durable Object's own SQLite.
 * One function per moment the pipeline records, so the orchestrator states
 * *what happened* and this file owns *how it is stored*.
 */

/** Whatever the caller records about the model behind a row. The shape is the
 * caller's business: the text row carries the model and its token usage, the
 * image row the model and the steps actually sent. */
type ModelMetadata = NewHeliosRun["modelMetadata"];

/**
 * Opens the text row as `running`, before the planner is called, so a crash
 * mid-call still leaves an inspectable audit trail.
 */
export async function startTextRun(
	db: HeliosDb,
	pInvocId: string,
	userPrompt: string,
	modelMetadata: ModelMetadata,
): Promise<void> {
	await db.insert(heliosRuns).values({
		pInvocId,
		modality: "text",
		status: "running",
		userPrompt,
		plannerParams: {},
		modelMetadata,
	});
}

/** Settles the text row with the params the planner actually produced. */
export async function completeTextRun(
        db: HeliosDb,
        pInvocId: string,
        params: HeliosParams,
        modelMetadata: ModelMetadata,
        costUsd: number | null,
): Promise<void> {
        await db
                .update(heliosRuns)
                .set({
                        status: "completed",
                        plannerParams: params,
                        modelMetadata,
                        costUsd,
                        completedAt: new Date(),
                })
                .where(and(eq(heliosRuns.pInvocId, pInvocId), eq(heliosRuns.modality, "text")));
}

/**
 * Opens the image row as `running`, duplicating planner_params from its text
 * sibling rather than requiring a join (ADR-0001).
 */
export async function startImageRun(
	db: HeliosDb,
	pInvocId: string,
	userPrompt: string,
	params: HeliosParams,
	modelMetadata: ModelMetadata,
): Promise<void> {
	await db.insert(heliosRuns).values({
		pInvocId,
		modality: "image",
		status: "running",
		userPrompt,
		plannerParams: params,
		modelMetadata,
	});
}

/** Settles the image row with its R2 key and cost. */
export async function completeImageRun(
	db: HeliosDb,
	pInvocId: string,
	imageR2Key: string,
	costUsd: number | null,
): Promise<void> {
	await db
		.update(heliosRuns)
		.set({ status: "completed", imageR2Key, costUsd, completedAt: new Date() })
		.where(and(eq(heliosRuns.pInvocId, pInvocId), eq(heliosRuns.modality, "image")));
}
/**
 * Marks whichever row is still `running` for this invocation as failed — just
 * the text row if planner/validate blew up, or the image row if image
 * generation did (text is already `completed` by that point).
 *
 * `costUsd` is written only when the caller has one, which happens when the
 * model call already billed and a later step broke. Left absent otherwise so a
 * planner-stage failure does not overwrite a cost with null.
 */
export async function failRunningRuns(
	db: HeliosDb,
	pInvocId: string,
	costUsd: number | null = null,
): Promise<void> {
	await db
		.update(heliosRuns)
		.set({ status: "failed", completedAt: new Date(), ...(costUsd !== null && { costUsd }) })
		.where(and(eq(heliosRuns.pInvocId, pInvocId), eq(heliosRuns.status, "running")));
}
