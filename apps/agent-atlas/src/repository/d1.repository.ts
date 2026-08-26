import { eq } from "drizzle-orm";
import { atlasRuns, type AtlasRun } from "../db/schema";
import type { AtlasD1Db } from "../db/client";

/**
 * D1 caps a query at 100 bound parameters, and a multi-row insert binds every
 * column of every row. `atlas_runs` has TWELVE columns, so eight rows is 96
 * parameters and nine would be 108.
 *
 * This deliberately differs from Helios's nine (`helios_runs` has eleven
 * columns) and from Iris's seven (`iris_runs` has thirteen). The arithmetic is
 * written out here so nobody "fixes" it to match either of the others.
 * https://developers.cloudflare.com/d1/platform/limits/
 */
const MAX_ROWS_PER_INSERT = 8;

/**
 * Copies settled rows into D1. Safe to call twice with the same rows: `id` is
 * generated in the DO and travels with the row, so a repeat conflicts on the
 * primary key and writes nothing.
 *
 * Note the flip side of `onConflictDoNothing` — it never updates either, so the
 * first version of a row to land is the one that stays forever. Only ever pass
 * rows that have settled (ADR-0010).
 */
export async function exportRuns(d1: AtlasD1Db, rows: AtlasRun[]): Promise<void> {
	// Chunked for the parameter cap above. A failure part way through is safe to
	// retry: the chunks already written conflict and do nothing next time.
	for (let i = 0; i < rows.length; i += MAX_ROWS_PER_INSERT) {
		await d1
			.insert(atlasRuns)
			.values(rows.slice(i, i + MAX_ROWS_PER_INSERT))
			.onConflictDoNothing();
	}
}

/** Reads a run's row back out of D1. Empty array when the run is not there. */
export async function readRun(d1: AtlasD1Db, pipelineId: string): Promise<AtlasRun[]> {
	return d1.select().from(atlasRuns).where(eq(atlasRuns.pipelineId, pipelineId));
}
