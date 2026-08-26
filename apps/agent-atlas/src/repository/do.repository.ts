import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { AtlasPlacement } from "@aureline/shared-types";
import type { AtlasDb } from "../db/client";
import { atlasRuns, type AtlasRun, type NewAtlasRun } from "../db/schema";

/**
 * Every read and write against `atlas_runs` in this Durable Object's own
 * SQLite. **This file is the only code in Atlas allowed to touch that table.**
 * No service, no route and no agent method runs a query directly.
 *
 * One function per moment the pipeline records, so the orchestrator states
 * *what happened* and this file owns *how it is stored*.
 *
 * Nine functions, where Helios has twelve. The three missing ones —
 * `startTextRun`, `completeTextRun`, `insertResumedTextRun` — all record a
 * planner call that Atlas does not make. If a later ticket seems to need one,
 * that is a signal Atlas grew a text call, which contradicts ADR-ATLAS-0001 and
 * is a group discussion rather than a quiet addition.
 */

/** Whatever the caller records about the model behind a row: the model, the
 * steps actually sent, and on a resume the `root`/`resumed_from`/`attempt`
 * markers. The shape is the caller's business. */
type ModelMetadata = NewAtlasRun["modelMetadata"];

/**
 * Everything an `atlas_runs` row needs that the caller decides.
 *
 * **One object, not six positional arguments.** Four of these are adjacent
 * strings, and nothing in the type system tells one string from another at a
 * call site — so swapping `patternRef` and `garmentRef` in a refactor would
 * compile, run, and silently write the garment URL into `pattern_ref`. That is
 * not hypothetical: the same shape of bug in another engine's `resume.ts`
 * corrupted a row, which then matched neither settled branch of a later guard
 * and fell through into generating another image, unbounded, at real cost.
 *
 * Field order matches the column order in `db/schema.ts`, so a call site can be
 * checked by reading it rather than by counting positions.
 */
export interface RowSeed {
	pipelineId: string;
	designSessionId: string;
	patternRef: string;
	garmentRef: string;
	/** Stored in the `garment_regions` column. */
	placement: AtlasPlacement;
	modelMetadata: ModelMetadata;
}

/**
 * Opens the run's row as `running`, before the image call, so a crash mid-call
 * still leaves an inspectable audit trail.
 *
 * One row, not two: Atlas has a single billable call (ADR-ATLAS-0001).
 */
export async function startRun(db: AtlasDb, seed: RowSeed): Promise<void> {
	const { placement, ...columns } = seed;
	await db.insert(atlasRuns).values({ ...columns, status: "running", garmentRegions: placement });
}

/**
 * Settles the row with its R2 key, cost and final metadata.
 *
 * **Reads the row first and throws when it is absent**, rather than running an
 * UPDATE that matches nothing. A blind update on a missing row succeeds, writes
 * nothing, and reports success — so an invocation that already spent money on a
 * billed image call would return `completed` with no `image_r2_key` and no cost
 * recorded anywhere. Failing loudly here puts it on the pipeline's failure path
 * instead, where it is reported as the failure it is.
 */
export async function completeRun(
	db: AtlasDb,
	pipelineId: string,
	imageR2Key: string,
	costUsd: number | null,
	modelMetadata: ModelMetadata,
): Promise<void> {
	const existing = await getRun(db, pipelineId);
	if (!existing) {
		throw new Error(
			`completeRun: no atlas_runs row for pipeline_id ${pipelineId}. The image call already billed, so this is a lost write rather than a missing run.`,
		);
	}

	await db
		.update(atlasRuns)
		.set({ status: "completed", imageR2Key, costUsd, modelMetadata, completedAt: new Date() })
		.where(eq(atlasRuns.pipelineId, pipelineId));
}

/**
 * Records a row for an invocation whose row never opened, so the failure is
 * visible rather than absent.
 *
 * This matters more for Atlas than for the other two engines. Helios and Iris
 * have two rows, so a failure while opening the second still leaves the first
 * behind and the invocation looks like *something*. Atlas has one row, so
 * without this rescue a failed invocation leaves **no trace at all**.
 *
 * Inserted already `failed` rather than opened and then settled, since the
 * thing being recorded has already happened.
 */
export async function insertFailedRun(db: AtlasDb, seed: RowSeed): Promise<void> {
	const { placement, ...columns } = seed;
	await db.insert(atlasRuns).values({
		...columns,
		status: "failed",
		garmentRegions: placement,
		completedAt: new Date(),
	});
}

/**
 * Marks this invocation's still-`running` row as failed.
 *
 * `costUsd` is written only when the caller has one, which happens when the
 * model call already billed and a later step broke. **Do not have it write
 * null**: the image call bills before the R2 save and the row update, so a
 * failure in either has to record money that already left the account.
 *
 * **Unlike `completeRun`, matching zero rows here is correct and must not
 * throw.** This is best-effort cleanup on the failure path: the row may already
 * have settled, or may never have opened at all (which is what `insertFailedRun`
 * exists to cover). Throwing would replace the real failure with a symptom of
 * it, from inside a catch block.
 */
export async function failRunningRuns(
	db: AtlasDb,
	pipelineId: string,
	costUsd: number | null = null,
): Promise<void> {
	await db
		.update(atlasRuns)
		.set({ status: "failed", completedAt: new Date(), ...(costUsd !== null && { costUsd }) })
		.where(and(eq(atlasRuns.pipelineId, pipelineId), eq(atlasRuns.status, "running")));
}

/**
 * How many times this brief has already been resumed, counted over the rows
 * carrying its `root`.
 *
 * **Counted by `root`, never by `resumed_from`.** Counting the immediate parent
 * would let a chain of resumes each start a fresh count and spend without
 * limit, which makes the cap in atlas-08 meaningless. Original runs carry no
 * `root`, so the count is resumes only: a configured 3 means an original plus
 * three retries rather than two.
 *
 * Counted over what this Durable Object still holds, not all time. That is
 * accurate where it matters: failed runs are never pruned, so failed attempts
 * persist, and a successful resume ends the chain anyway because the guard
 * refuses a run that already has an image.
 *
 * Filtered in memory rather than through `json_extract` because a DO holds a
 * handful of rows and Drizzle hands the JSON column back already parsed.
 */
export async function countResumeAttempts(db: AtlasDb, root: string): Promise<number> {
	const rows = await db.select({ modelMetadata: atlasRuns.modelMetadata }).from(atlasRuns);

	return rows.filter((row) => (row.modelMetadata as { root?: unknown } | null)?.root === root).length;
}

/**
 * The row for one invocation, or undefined.
 *
 * Singular, unlike Helios's `getRunRows`, because Atlas has one row per
 * invocation. A plural name on a function that can only ever return one row is
 * a lie somebody will write a loop against.
 */
export async function getRun(db: AtlasDb, pipelineId: string): Promise<AtlasRun | undefined> {
	const rows = await db.select().from(atlasRuns).where(eq(atlasRuns.pipelineId, pipelineId));
	return rows[0];
}

/**
 * Every row in this DO, newest first, for showing a session's history.
 *
 * Unlike `getSettledRows` this **includes `running` rows**, because a caller
 * looking at a session wants to see an invocation still in flight rather than
 * have it silently missing. It is a read for humans, never for the exporter.
 *
 * Unbounded on purpose. The set is already bounded by retention: only
 * `retention_limit` completed runs survive a prune. Failed runs are never
 * pruned, so a session that fails a lot grows, and a limit here would silently
 * hide the failures somebody came looking for.
 */
export async function listRuns(db: AtlasDb): Promise<AtlasRun[]> {
	return db.select().from(atlasRuns).orderBy(desc(atlasRuns.createdAt));
}

/**
 * Every row in this DO that has reached a terminal status, for handing to the
 * exporter. The whole DO rather than one invocation, because pruning deletes
 * from the whole DO: exporting less than it prunes is how a run that failed to
 * export earlier gets deleted later by somebody else's successful export
 * (ADR-0010).
 *
 * `running` rows are excluded here rather than at the call site, so there is
 * one place to get it right. `exportRuns` never overwrites a row once it lands,
 * so exporting one early would freeze a null cost and a null `completed_at`
 * into D1 permanently.
 */
export async function getSettledRows(db: AtlasDb): Promise<AtlasRun[]> {
	return db.select().from(atlasRuns).where(ne(atlasRuns.status, "running"));
}

/**
 * Deletes completed runs beyond the limit, oldest first. Failed runs are never
 * touched, at any age: the failure record is the thing somebody came back for,
 * and it is what makes a resume possible days later. `running` rows are left
 * alone too — a concurrent in-flight invocation is not garbage.
 *
 * Returns how many runs were deleted.
 *
 * `retentionLimit` is an argument, never `env.RETENTION_LIMIT` and never a
 * hardcoded 5. Config reading belongs in config.ts only; this exact box was
 * unticked at review in Helios's sprint.
 *
 * Simpler than Helios's equivalent, which has to group rows by `pipeline_id` to
 * avoid orphaning an image row whose text sibling was deleted. Atlas has one
 * row per invocation, so a row *is* a run and there is nothing to group.
 */
export async function pruneCompletedRuns(db: AtlasDb, retentionLimit: number): Promise<number> {
	// Only the two fields the sort below reads. Selecting whole rows would drag
	// both JSON blobs across on every request, and this scan only grows: failed
	// runs are never pruned.
	const completed = await db
		.select({ pipelineId: atlasRuns.pipelineId, createdAt: atlasRuns.createdAt })
		.from(atlasRuns)
		.where(eq(atlasRuns.status, "completed"))
		.orderBy(desc(atlasRuns.createdAt));

	const runsToDelete = completed.slice(retentionLimit);
	if (runsToDelete.length === 0) return 0;

	await db.delete(atlasRuns).where(
		inArray(
			atlasRuns.pipelineId,
			runsToDelete.map((run) => run.pipelineId),
		),
	);

	return runsToDelete.length;
}
