import { and, eq } from "drizzle-orm";
import { heliosRuns, type HeliosRun } from "../db/schema";
import type { HeliosD1Db } from "../db/client";

/** Copies settled rows into D1. Safe to call twice with the same rows. */
export async function exportRuns(d1: HeliosD1Db, rows: HeliosRun[]): Promise<void> {
	if (rows.length === 0) return;

	await d1
		.insert(heliosRuns)
		.values(rows)
		.onConflictDoNothing();
}

/** Reads a run's rows back out of D1. Empty array when the run is not there. */
export async function readRun(d1: HeliosD1Db, pInvocId: string): Promise<HeliosRun[]> {
	return d1
		.select()
		.from(heliosRuns)
		.where(eq(heliosRuns.pInvocId, pInvocId));
}