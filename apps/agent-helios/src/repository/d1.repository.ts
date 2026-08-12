import { eq } from "drizzle-orm";
import { heliosRuns, type HeliosRun } from "../db/schema";
import type { HeliosD1Db } from "../db/client";

/**
 * D1 caps a query at 100 bound parameters, and a multi-row insert binds every
 * column of every row. `helios_runs` has 11 columns, so nine rows is the most
 * one statement can carry.
 * https://developers.cloudflare.com/d1/platform/limits/
 */
const MAX_ROWS_PER_INSERT = 9;

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
export async function readRun(d1: HeliosD1Db, pInvocId: string): Promise<HeliosRun[]> {
	return d1
		.select()
		.from(heliosRuns)
		.where(eq(heliosRuns.pInvocId, pInvocId));
}