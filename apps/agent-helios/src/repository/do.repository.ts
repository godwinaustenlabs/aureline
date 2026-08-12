import { and, eq, inArray, ne } from "drizzle-orm";
import type { HeliosParams } from "@aureline/shared-types";
import type { HeliosDb } from "../db/client";
import { heliosRuns, type HeliosRun, type NewHeliosRun } from "../db/schema";

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

/** The rows for one invocation. */
export async function getRunRows(db: HeliosDb, pInvocId: string): Promise<HeliosRun[]> {
	return db.select().from(heliosRuns).where(eq(heliosRuns.pInvocId, pInvocId));
}

/**
 * Every row in this DO that has reached a terminal status, for handing to the
 * exporter. The whole DO rather than one invocation, because pruning deletes
 * from the whole DO: exporting less than it prunes is how a run that failed to
 * export earlier gets deleted later by someone else's successful export.
 *
 * `running` rows are excluded deliberately. One DO serves one session
 * (ADR-0005) and two overlapping invocations can leave a half-written row
 * here. `exportRuns` never overwrites a row once it lands, so exporting one
 * early would freeze null params and a null cost into D1 permanently.
 */
export async function getSettledRows(db: HeliosDb): Promise<HeliosRun[]> {
	return db.select().from(heliosRuns).where(ne(heliosRuns.status, "running"));
}

/**
 * Deletes completed runs beyond the limit, oldest first, whole runs only.
 * Failed runs are never touched. Returns how many runs were deleted.
 */
export async function pruneCompletedRuns(db: HeliosDb, retentionLimit: number): Promise<number> {
	// Only the three fields the grouping below actually reads. Selecting the
	// whole row would drag user_prompt and both JSON blobs across on every
	// request, and this scan only grows: failed runs are never pruned.
	const allRows = await db
		.select({
			pInvocId: heliosRuns.pInvocId,
			status: heliosRuns.status,
			createdAt: heliosRuns.createdAt,
		})
		.from(heliosRuns);

	const byRun = new Map<string, (typeof allRows)[number][]>();
	for (const row of allRows) {
		const existing = byRun.get(row.pInvocId);
		if (existing) {
			existing.push(row);
		} else {
			byRun.set(row.pInvocId, [row]);
		}
	}

	const completedRuns = [...byRun.entries()]
		.filter(([, rows]) => rows.every((row) => row.status === "completed"))
		.map(([pInvocId, rows]) => ({
			pInvocId,
			latestCreatedAt: Math.max(...rows.map((row) => row.createdAt.getTime())),
		}))
		.sort((a, b) => b.latestCreatedAt - a.latestCreatedAt);

	const runsToDelete = completedRuns.slice(retentionLimit);
	if (runsToDelete.length === 0) return 0;

	await db.delete(heliosRuns).where(
		inArray(
			heliosRuns.pInvocId,
			runsToDelete.map((run) => run.pInvocId),
		),
	);

	return runsToDelete.length;
}