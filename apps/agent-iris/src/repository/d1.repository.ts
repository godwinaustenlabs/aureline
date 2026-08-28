import { eq } from "drizzle-orm";
import { irisRuns, type IrisRun } from "../db/schema";
import type { IrisD1Db } from "../db/client";

/**
 * D1 caps a statement at 100 bound parameters, and a multi-row insert binds
 * every column of every row. `iris_runs` has 13 columns, so seven rows is the
 * most one statement can carry: 13 x 7 = 91, and 13 x 8 = 104.
 * https://developers.cloudflare.com/d1/platform/limits/
 *
 * **This number is derived from the column count, so it is not a constant
 * anyone may leave alone after a schema change.** Two more columns makes it
 * 15 x 7 = 105 and this has to drop to 6. That is the reason `width` and
 * `height` are recorded inside `model_metadata` rather than becoming columns
 * of their own (iris-03 decision 9).
 *
 * Helios uses 8 because `helios_runs` has 12 columns. Copying that number
 * across is the single most likely mistake in this file: it looks right, every
 * small export works, and it fails the first time one carries eight or more
 * rows, which is exactly when there is real history worth not losing.
 */
export const MAX_ROWS_PER_INSERT = 7;

/**
 * D1's cap, exported so a test can re-derive the line above from the schema
 * rather than trusting it.
 *
 * The chunking test alone cannot catch a wrong number here: it runs against
 * `node:sqlite`, which has no parameter cap, so fifteen rows land whether the
 * chunk size is 7 or Helios's 9. Only arithmetic against the real column count
 * fails when the constant drifts, which is the point of exporting both.
 */
export const D1_BOUND_PARAMETER_LIMIT = 100;

/**
 * Copies settled rows into D1. Safe to call twice with the same rows: `id` is
 * generated in the DO (`schema.ts`, `$defaultFn`) and travels with the row, so
 * a repeat conflicts on the primary key and writes nothing. That is what makes
 * a failure part way through safe to retry, and it is why an export that fails
 * needs no recovery route of its own.
 *
 * Note the flip side of `onConflictDoNothing` — it never updates either, so the
 * first version of a row to land is the one that stays forever. **Only ever
 * pass rows that have settled.** A `running` row exported early would be frozen
 * in D1 with a null cost and no image key, and nothing would ever correct it
 * (ADR-0010). `getSettledRows` is the filter that guarantees this.
 */
export async function exportRuns(d1: IrisD1Db, rows: IrisRun[]): Promise<void> {
	// Chunked for the parameter cap above. A failure part way through is safe to
	// retry: the chunks already written conflict and do nothing next time.
	for (let i = 0; i < rows.length; i += MAX_ROWS_PER_INSERT) {
		await d1
			.insert(irisRuns)
			.values(rows.slice(i, i + MAX_ROWS_PER_INSERT))
			.onConflictDoNothing();
	}
}

/** Reads a run's rows back out of D1. Empty array when the run is not there. */
export async function readRun(d1: IrisD1Db, pipelineId: string): Promise<IrisRun[]> {
	return d1.select().from(irisRuns).where(eq(irisRuns.pipelineId, pipelineId));
}
