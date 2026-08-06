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
 * caller's business — tickets 05/06 replace today's stubs. */
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
): Promise<void> {
	await db
		.update(heliosRuns)
		.set({ status: "completed", plannerParams: params, completedAt: new Date() })
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

/** Settles the image row with its cost. */
export async function completeImageRun(
	db: HeliosDb,
	pInvocId: string,
	costUsd: number | null,
): Promise<void> {
	await db
		.update(heliosRuns)
		.set({ status: "completed", costUsd, completedAt: new Date() })
		.where(and(eq(heliosRuns.pInvocId, pInvocId), eq(heliosRuns.modality, "image")));
}

/**
 * Marks whichever row is still `running` for this invocation as failed — just
 * the text row if planner/validate blew up, or the image row if image
 * generation did (text is already `completed` by that point).
 */
export async function failRunningRuns(db: HeliosDb, pInvocId: string): Promise<void> {
	await db
		.update(heliosRuns)
		.set({ status: "failed", completedAt: new Date() })
		.where(and(eq(heliosRuns.pInvocId, pInvocId), eq(heliosRuns.status, "running")));
}
