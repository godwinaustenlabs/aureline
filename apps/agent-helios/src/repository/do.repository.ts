import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { Classification, HeliosParams } from "@aureline/shared-types";
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
 * What every row-opening function needs to write a row.
 *
 * One object rather than a line-up of positional strings (AGENTS.md §6). Three
 * of these are adjacent strings, and before this they were passed positionally:
 * swapping any two compiled, ran, and corrupted a row. Now a swap is a compile
 * error.
 *
 * Field order mirrors `db/schema.ts`, so a reader checking a call site can check
 * it by looking rather than by counting.
 */
type RowSeed = {
	pipelineId: string;
	designSessionId: string;
	userPrompt: string;
	/**
	 * Either the planner's params, or `{}` when there are none — a run that
	 * failed at persist, planner or validate still has to write its image row
	 * (ADR-0001) and genuinely has nothing to put here.
	 *
	 * Spelled as a union rather than accepting `HeliosParams` and letting callers
	 * cast `{}` into it. The empty case is real, so the type says so; and a
	 * *wrong* shape still fails, because a half-built params object matches
	 * neither branch.
	 */
	plannerParams: HeliosParams | Record<string, never>;
	modelMetadata: ModelMetadata;
	/**
	 * The classifier's answer, or `{}` on a row written before it ran.
	 *
	 * Optional here because the column has a database default of `{}` — a row
	 * that omits it is opened unclassified, which is the honest state for a text
	 * row created before the classifier is called.
	 */
	classification?: Classification | Record<string, never>;
};

/**
 * Opens the text row as `running`, before the planner is called, so a crash
 * mid-call still leaves an inspectable audit trail.
 */
export async function startTextRun(db: HeliosDb, seed: Omit<RowSeed, "plannerParams">): Promise<void> {
	await db.insert(heliosRuns).values({
		...seed,
		modality: "text",
		status: "running",
		plannerParams: {},
	});
}

/**
 * Records what the classifier decided, as soon as it decides it.
 *
 * **Written at the classify stage rather than folded into `completeTextRun`**,
 * so a run that fails at research or planner still says what kind of design it
 * thought it was making. That is the difference between a failed row you can
 * diagnose and one that only says it failed.
 *
 * Throws when there is no text row, for the reason `completeTextRun` does: a
 * bare `UPDATE … WHERE` matching nothing resolves exactly as if it had worked.
 */
export async function recordClassification(
	db: HeliosDb,
	pipelineId: string,
	classification: Classification,
): Promise<void> {
	const [existing] = await db
		.select({ id: heliosRuns.id })
		.from(heliosRuns)
		.where(and(eq(heliosRuns.pipelineId, pipelineId), eq(heliosRuns.modality, "text")));

	if (!existing) {
		throw new Error(`no text row to classify for pipeline_id ${pipelineId}`);
	}

	await db
		.update(heliosRuns)
		.set({ classification })
		.where(and(eq(heliosRuns.pipelineId, pipelineId), eq(heliosRuns.modality, "text")));
}

/**
 * Settles the text row with the params the planner actually produced.
 *
 * **Throws when there is no text row to settle.** A bare `UPDATE ... WHERE`
 * against a row that is not there matches nothing and resolves exactly as if it
 * had worked, so "the insert never landed" and "the insert landed fine" were
 * indistinguishable from here. That is not theoretical at this call site: if
 * `startTextRun` silently no-opped, the pipeline would carry on into the image
 * stage and return `status: "completed"` for an invocation with no rows in the
 * table at all (AGENTS.md §7).
 */
export async function completeTextRun(
	db: HeliosDb,
	pipelineId: string,
	params: HeliosParams,
	modelMetadata: ModelMetadata,
	costUsd: number | null,
): Promise<void> {
	const [existing] = await db
		.select({ id: heliosRuns.id })
		.from(heliosRuns)
		.where(and(eq(heliosRuns.pipelineId, pipelineId), eq(heliosRuns.modality, "text")));

	if (!existing) {
		throw new Error(`no text row to settle for pipeline_id ${pipelineId}`);
	}

	await db
		.update(heliosRuns)
		.set({
			status: "completed",
			plannerParams: params,
			modelMetadata,
			costUsd,
			completedAt: new Date(),
		})
		.where(and(eq(heliosRuns.pipelineId, pipelineId), eq(heliosRuns.modality, "text")));
}

/**
 * The text row of a resumed run, inserted already settled.
 *
 * A resume never calls the planner, so this row has no `running` phase to open
 * and no cost to record — it exists because ADR-0001 says one invocation is two
 * rows, and a resume that wrote only an image row would leave anything reading
 * D1 with half a run.
 *
 * `costUsd` is left null deliberately. Copying the original planner's cost here
 * would bill the same planner call twice across our cost reports.
 */
export async function insertResumedTextRun(db: HeliosDb, seed: RowSeed): Promise<void> {
	await db.insert(heliosRuns).values({
		...seed,
		modality: "text",
		status: "completed",
		completedAt: new Date(),
	});
}

/**
 * Opens the image row as `running`, duplicating planner_params from its text
 * sibling rather than requiring a join (ADR-0001).
 */
export async function startImageRun(db: HeliosDb, seed: RowSeed): Promise<void> {
	await db.insert(heliosRuns).values({
		...seed,
		modality: "image",
		status: "running",
	});
}

/**
 * Records an image row for an invocation whose image row never opened, so the
 * failure is visible rather than absent.
 *
 * Without it, a failure while opening the image row leaves the invocation as a
 * lone `completed` text row: `failRunningRuns` finds nothing to mark, so D1
 * shows a run that looks finished and successful, and `pruneCompletedRuns`
 * deletes it like any other completed run because every row it has is
 * `completed`. Both are wrong, and the second loses the record entirely.
 *
 * Inserted already `failed` rather than opened and then settled, since the
 * thing being recorded has already happened.
 */
export async function insertFailedImageRun(db: HeliosDb, seed: RowSeed): Promise<void> {
	await db.insert(heliosRuns).values({
		...seed,
		modality: "image",
		status: "failed",
		completedAt: new Date(),
	});
}

/**
 * Settles the image row with its R2 key and cost.
 *
 * **Throws when there is no image row to settle.** The caller has just paid for
 * an image by the time this runs, and an `UPDATE` that matches zero rows reports
 * success just as loudly as one that matched. Silently failing to record a spent
 * image is how a run that cost real money ends up looking like it never happened
 * (AGENTS.md §7).
 *
 * `modelMetadata` is **merged over** what the row already carries rather than
 * replacing it. The row was opened before the call, so its metadata is a
 * prediction; this is where the caller replaces the predicted fields with what
 * actually happened, without discarding markers a resume put there.
 */
export async function completeImageRun(
	db: HeliosDb,
	settle: {
		pipelineId: string;
		imageR2Key: string;
		costUsd: number | null;
		modelMetadata?: ModelMetadata;
	},
): Promise<void> {
	const { pipelineId, imageR2Key, costUsd, modelMetadata = {} } = settle;

	const [existing] = await db
		.select({ modelMetadata: heliosRuns.modelMetadata })
		.from(heliosRuns)
		.where(and(eq(heliosRuns.pipelineId, pipelineId), eq(heliosRuns.modality, "image")));

	if (!existing) {
		throw new Error(`no image row to settle for pipeline_id ${pipelineId}`);
	}

	const mergedMetadata = {
		...((existing.modelMetadata as Record<string, unknown> | null) ?? {}),
		...(modelMetadata as Record<string, unknown>),
	};

	await db
		.update(heliosRuns)
		.set({ status: "completed", imageR2Key, costUsd, modelMetadata: mergedMetadata, completedAt: new Date() })
		.where(and(eq(heliosRuns.pipelineId, pipelineId), eq(heliosRuns.modality, "image")));
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
	pipelineId: string,
	costUsd: number | null = null,
): Promise<void> {
	await db
		.update(heliosRuns)
		.set({ status: "failed", completedAt: new Date(), ...(costUsd !== null && { costUsd }) })
		.where(and(eq(heliosRuns.pipelineId, pipelineId), eq(heliosRuns.status, "running")));
}

/**
 * How many times this brief has already been resumed, counted over the image
 * rows carrying its `root`.
 *
 * Image rows because they are the ones that spend money, and a cap on retries
 * is a cap on spend. Original runs carry no `root`, so the count is resumes
 * only: a configured 3 means an original plus three retries rather than two.
 *
 * Counted over what this Durable Object still holds, not all time. That is
 * accurate where it matters: failed runs are never pruned, so failed attempts
 * persist, and a successful resume ends the chain anyway because the guard
 * refuses a run that already has an image.
 *
 * Filtered in memory rather than through `json_extract` because a DO holds a
 * handful of rows and Drizzle hands the JSON column back already parsed.
 *
 * **A row whose metadata cannot be read counts toward the cap.** It used to be
 * filtered out by a `?.root === root` that treated unreadable and "belongs to a
 * different chain" as the same answer, so a row that failed to serialise made
 * the cap generous rather than strict. This is a spend limit, so the unknown
 * case errs toward refusing rather than toward another image call (AGENTS.md §7).
 * An original run is a different matter and is still not counted: its metadata
 * is perfectly readable and simply carries no `root`.
 */
export async function countResumeAttempts(db: HeliosDb, root: string): Promise<number> {
	const rows = await db
		.select({ modelMetadata: heliosRuns.modelMetadata })
		.from(heliosRuns)
		.where(eq(heliosRuns.modality, "image"));

	return rows.filter((row) => {
		const metadata = row.modelMetadata;

		if (metadata === null || typeof metadata !== "object") {
			console.warn(`resume cap: image row with unreadable model_metadata counted toward root ${root}`);
			return true;
		}

		return (metadata as { root?: unknown }).root === root;
	}).length;
}

/** The rows for one invocation. */
export async function getRunRows(db: HeliosDb, pipelineId: string): Promise<HeliosRun[]> {
	return db.select().from(heliosRuns).where(eq(heliosRuns.pipelineId, pipelineId));
}

/**
 * The classification for a design, read from the first text row matching the
 * design session id. Returns `undefined` when no row exists — the caller
 * decides whether that is an error or a fallback.
 *
 * Selects only the classification column. The rest of the row is not needed and
 * not fetched, so a DO with many runs does not drag the full table across the
 * wire for one JSON blob.
 */
export async function getClassificationByDesignSession(
	db: HeliosDb,
	designSessionId: string,
): Promise<{ classification: unknown } | undefined> {
	const [row] = await db
		.select({ classification: heliosRuns.classification })
		.from(heliosRuns)
		.where(
			and(
				eq(heliosRuns.designSessionId, designSessionId),
				eq(heliosRuns.modality, "text"),
			),
		)
		.limit(1);

	return row;
}

/**
 * Every row in this DO, newest first, for showing a session's history.
 *
 * Unlike `getSettledRows` this **includes `running` rows**, because a caller
 * looking at a session wants to see an invocation that is still in flight, not
 * have it silently missing. It is a read for humans, never for the exporter.
 *
 * Unbounded on purpose. The set is already bounded by retention: only
 * `retention_limit` completed runs survive a prune. Failed runs are never
 * pruned, so a session that fails a lot grows, and a limit here would silently
 * hide the failures someone came looking for.
 */
export async function listRuns(db: HeliosDb): Promise<HeliosRun[]> {
	return db.select().from(heliosRuns).orderBy(desc(heliosRuns.createdAt));
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
			pipelineId: heliosRuns.pipelineId,
			status: heliosRuns.status,
			createdAt: heliosRuns.createdAt,
		})
		.from(heliosRuns);

	const byRun = new Map<string, (typeof allRows)[number][]>();
	for (const row of allRows) {
		const existing = byRun.get(row.pipelineId);
		if (existing) {
			existing.push(row);
		} else {
			byRun.set(row.pipelineId, [row]);
		}
	}

	const completedRuns = [...byRun.entries()]
		.filter(([, rows]) => rows.every((row) => row.status === "completed"))
		.map(([pipelineId, rows]) => ({
			pipelineId,
			latestCreatedAt: Math.max(...rows.map((row) => row.createdAt.getTime())),
		}))
		.sort((a, b) => b.latestCreatedAt - a.latestCreatedAt);

	const runsToDelete = completedRuns.slice(retentionLimit);
	if (runsToDelete.length === 0) return 0;

	await db.delete(heliosRuns).where(
		inArray(
			heliosRuns.pipelineId,
			runsToDelete.map((run) => run.pipelineId),
		),
	);

	return runsToDelete.length;
}