import { eq } from "drizzle-orm";
import { heliosRuns, type HeliosRun } from "../db/schema";
import type { HeliosD1Db } from "../db/client";

/**
 * D1 caps a statement at 100 bound parameters, and a multi-row insert binds
 * every column of every row. `helios_runs` has 12 columns, so eight rows is the
 * most one statement can carry: 12 x 8 = 96, and 12 x 9 = 108.
 * https://developers.cloudflare.com/d1/platform/limits/
 *
 * **This number is derived from the column count, so it is not a constant
 * anyone may leave alone after a schema change.** It was 9 when the table had
 * 11 columns, and `design_session_id` is what took it over: 12 x 9 = 108 would
 * have exceeded the cap on the first export carrying nine rows.
 *
 * Exported so `d1.repository.test.ts` can check it against the real column
 * count rather than against a number someone typed twice. `node:sqlite` has no
 * parameter cap, so no amount of exporting rows through the test fake can catch
 * this being wrong — only the arithmetic can.
 *
 * That failure is invisible from the outside. `exportAndPrune` swallows what it
 * catches by design, so every run still returns `completed` while nothing
 * reaches D1 — and it only starts happening once a session has eight or more
 * settled rows, which is exactly when there is real history worth not losing.
 */
export const MAX_ROWS_PER_INSERT = 8;

/**
 * Copies settled rows into D1. Safe to call twice with the same rows: `id` is
 * generated in the DO and travels with the row, so a repeat conflicts on the
 * primary key and writes nothing.
 *
 * Note the flip side of `onConflictDoNothing` — it never updates either, so the
 * first version of a row to land is the one that stays. Only ever pass rows
 * that have settled.
 */
export async function exportRuns(d1: HeliosD1Db, rows: HeliosRun[]): Promise<void> {
	// Chunked for the parameter cap above. A failure part way through is safe to
	// retry: the chunks already written conflict and do nothing next time.
	for (let i = 0; i < rows.length; i += MAX_ROWS_PER_INSERT) {
		await d1
			.insert(heliosRuns)
			.values(rows.slice(i, i + MAX_ROWS_PER_INSERT))
			.onConflictDoNothing();
	}
}

/** Reads a run's rows back out of D1. Empty array when the run is not there. */
export async function readRun(d1: HeliosD1Db, pipelineId: string): Promise<HeliosRun[]> {
	return d1
		.select()
		.from(heliosRuns)
		.where(eq(heliosRuns.pipelineId, pipelineId));
}
