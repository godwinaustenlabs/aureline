import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { IrisParams } from "@aureline/shared-types";
import type { IrisDb } from "../db/client";
import { irisRuns, type IrisRun, type NewIrisRun } from "../db/schema";

/**
 * Every write against `iris_runs` in this Durable Object's own SQLite.
 * One function per moment the pipeline records, so the orchestrator states
 * *what happened* and this file owns *how it is stored*.
 */

/** Whatever the caller records about the model behind a row. The shape is the
 * caller's business: the text row carries the model and its token usage, the
 * image row the model and the steps actually sent. */
type ModelMetadata = NewIrisRun["modelMetadata"];

/**
 * What every function that **opens a row** is given, as one object rather than a
 * line-up of positional strings (AGENTS.md §6).
 *
 * Four adjacent `string` parameters is the shape that caused Helios's runaway
 * image loop: swap any two and it compiles, runs, and writes a corrupted row
 * whose `status` is then never found. As an object, the same mistake is a
 * compile error.
 *
 * Field order mirrors the column order in `db/schema.ts`, so a reader checking a
 * call against the table can do it by looking rather than by counting.
 *
 * `userPrompt` is the caller's `concept` — the request calls it one thing and
 * the column the other. The column name is the older of the two and is what
 * every query already uses, so the mismatch stays and is named here instead of
 * being left for a reader to discover.
 */
type RowSeed = {
	pipelineId: string;
	designSessionId: string;
	userPrompt: string;
	motifRef: string;
	/**
	 * Either the planner's params, or `{}` when there are none — a run that
	 * failed at persist, planner or validate still has to write its image row
	 * (ADR-0001) and genuinely has nothing to put here.
	 *
	 * Spelled as a union rather than accepting `IrisParams` and letting callers
	 * cast `{}` into it. The empty case is real, so the type says so; and a
	 * *wrong* shape still fails, because a half-built params object matches
	 * neither branch.
	 */
	plannerParams: IrisParams | Record<string, never>;
	modelMetadata: ModelMetadata;
};

/**
 * Opens the text row as `running`, before the planner is called, so a crash
 * mid-call still leaves an inspectable audit trail.
 *
 * Takes no `plannerParams`: the planner has not run yet, so the column opens
 * empty and `completeTextRun` settles it.
 */
export async function startTextRun(db: IrisDb, seed: Omit<RowSeed, "plannerParams">): Promise<void> {
	await db.insert(irisRuns).values({
		...seed,
		modality: "text",
		status: "running",
		plannerParams: {},
	});
}

/** Settles the text row with the params the planner actually produced. */
export async function completeTextRun(
	db: IrisDb,
	pipelineId: string,
	params: IrisParams,
	modelMetadata: ModelMetadata,
	costUsd: number | null,
): Promise<void> {
	await db
		.update(irisRuns)
		.set({
			status: "completed",
			plannerParams: params,
			modelMetadata,
			costUsd,
			completedAt: new Date(),
		})
		.where(and(eq(irisRuns.pipelineId, pipelineId), eq(irisRuns.modality, "text")));
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
export async function insertResumedTextRun(db: IrisDb, seed: RowSeed): Promise<void> {
	await db.insert(irisRuns).values({
		...seed,
		modality: "text",
		status: "completed",
		completedAt: new Date(),
	});
}

/**
 * Opens the image row as `running`, duplicating planner_params and motif_ref
 * from its text sibling rather than requiring a join (ADR-0001).
 */
export async function startImageRun(db: IrisDb, seed: RowSeed): Promise<void> {
	await db.insert(irisRuns).values({
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
export async function insertFailedImageRun(db: IrisDb, seed: RowSeed): Promise<void> {
	await db.insert(irisRuns).values({
		...seed,
		modality: "image",
		status: "failed",
		completedAt: new Date(),
	});
}

/**
 * Settles the image row with its R2 key and cost.
 *
 * An object rather than positional arguments because `pipelineId` and
 * `imageR2Key` are both strings: swapping them would key the update on an R2
 * path, match nothing, and leave a spent image row open forever (AGENTS.md §6).
 *
 * `modelMetadata` is merged over the row's existing metadata rather than
 * replacing it. `startImageRun` runs before the model call, when returned
 * dimensions are not known yet, so this is the only moment at which they can
 * be recorded — and merging keeps whatever `startImageRun` already wrote
 * (the model name, the steps sent) intact rather than overwriting it.
 *
 * **Throws when there is no image row to settle.** It used to merge over
 * `existing?.modelMetadata ?? {}` and then run an `UPDATE` that matched nothing,
 * so "the row is missing" and "the row has empty metadata" were indistinguishable
 * and both reported success. The caller has just paid for an image at this
 * point; silently failing to record it is how a spent run ends up looking like it
 * never happened (AGENTS.md §7).
 */
export async function completeImageRun(
	db: IrisDb,
	settle: {
		pipelineId: string;
		imageR2Key: string;
		costUsd: number | null;
		modelMetadata?: ModelMetadata;
	},
): Promise<void> {
	const { pipelineId, imageR2Key, costUsd, modelMetadata = {} } = settle;

	const [existing] = await db
		.select({ modelMetadata: irisRuns.modelMetadata })
		.from(irisRuns)
		.where(and(eq(irisRuns.pipelineId, pipelineId), eq(irisRuns.modality, "image")));

	if (!existing) {
		throw new Error(`no image row to settle for pipeline_id ${pipelineId}`);
	}

	const mergedMetadata = {
		...((existing.modelMetadata as Record<string, unknown> | null) ?? {}),
		...(modelMetadata as Record<string, unknown>),
	};

	await db
		.update(irisRuns)
		.set({ status: "completed", imageR2Key, costUsd, modelMetadata: mergedMetadata, completedAt: new Date() })
		.where(and(eq(irisRuns.pipelineId, pipelineId), eq(irisRuns.modality, "image")));
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
	db: IrisDb,
	pipelineId: string,
	costUsd: number | null = null,
): Promise<void> {
	await db
		.update(irisRuns)
		.set({ status: "failed", completedAt: new Date(), ...(costUsd !== null && { costUsd }) })
		.where(and(eq(irisRuns.pipelineId, pipelineId), eq(irisRuns.status, "running")));
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
 */
export async function countResumeAttempts(db: IrisDb, root: string): Promise<number> {
	const rows = await db
		.select({ modelMetadata: irisRuns.modelMetadata })
		.from(irisRuns)
		.where(eq(irisRuns.modality, "image"));

	return rows.filter((row) => (row.modelMetadata as { root?: unknown } | null)?.root === root).length;
}

/** The rows for one invocation. */
export async function getRunRows(db: IrisDb, pipelineId: string): Promise<IrisRun[]> {
	return db.select().from(irisRuns).where(eq(irisRuns.pipelineId, pipelineId));
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
export async function listRuns(db: IrisDb): Promise<IrisRun[]> {
	return db.select().from(irisRuns).orderBy(desc(irisRuns.createdAt));
}

/**
 * Every row in this DO that has reached a terminal status, for handing to the
 * exporter. The whole DO rather than one invocation, because pruning deletes
 * from the whole DO: exporting less than it prunes is how a run that failed to
 * export earlier gets deleted later by someone else's successful export.
 *
 * `running` rows are excluded deliberately (ADR-0010). One DO serves one
 * session (ADR-0005) and two overlapping invocations can leave a
 * half-written row here. The exporter never overwrites a row once it lands,
 * so exporting one early would freeze null params and a null cost into D1
 * permanently.
 */
export async function getSettledRows(db: IrisDb): Promise<IrisRun[]> {
	return db.select().from(irisRuns).where(ne(irisRuns.status, "running"));
}

/**
 * Deletes completed runs beyond the limit, oldest first, whole runs only.
 * Failed runs are never touched. Returns how many runs were deleted.
 *
 * `retentionLimit` is always the caller's argument, never read from `env`
 * here — config reading belongs in `config.ts` only.
 */
export async function pruneCompletedRuns(db: IrisDb, retentionLimit: number): Promise<number> {
	// Only the three fields the grouping below actually reads. Selecting the
	// whole row would drag user_prompt and both JSON blobs across on every
	// request, and this scan only grows: failed runs are never pruned.
	const allRows = await db
		.select({
			pipelineId: irisRuns.pipelineId,
			status: irisRuns.status,
			createdAt: irisRuns.createdAt,
		})
		.from(irisRuns);

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

	await db.delete(irisRuns).where(
		inArray(
			irisRuns.pipelineId,
			runsToDelete.map((run) => run.pipelineId),
		),
	);

	return runsToDelete.length;
}
