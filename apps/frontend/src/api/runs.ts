/**
 * The audit rows as `GET /runs` hands them back, for all three engines.
 *
 * These are Drizzle's own select shape, serialised, and the route deliberately
 * does not reshape them — the point of that route is to show what is actually
 * stored. So the field names are camelCase and the timestamps arrive as ISO
 * strings rather than the `Date`s the worker holds.
 *
 * They are a read model for a debug page rather than a wire contract, which is
 * why they live here and not in `@aureline/shared-types`: nothing validates
 * against them and nothing else needs to agree with them.
 *
 * **The three tables genuinely differ.** Mirrors `db/schema.ts` in each engine:
 *
 * | | run id | rows / invocation | its own columns |
 * |---|---|---|---|
 * | `helios_runs` | `pInvocId` | 2, by `modality` | — |
 * | `iris_runs` | `pipelineId` | 2, by `modality` | `motifRef`, `designSessionId` |
 * | `atlas_runs` | `pipelineId` | **1, no `modality`** | `patternRef`, `garmentRef`, `garmentRegions` |
 */

export type RunStatus = 'running' | 'completed' | 'failed';

/** What every engine's row carries, whatever else it adds. */
interface CommonRow {
	id: string;
	status: RunStatus;
	imageR2Key: string | null;
	/** Real dollars, or null when the AI Gateway log was missing. **Null is not
	 *  zero:** a failed call that never reached the model was never charged. */
	costUsd: number | null;
	/** A JSON column, shape differs by engine and modality. Untrusted — a row
	 *  written under an older schema must fail loudly rather than render as
	 *  nonsense. */
	modelMetadata: unknown;
	createdAt: string;
	/** Null while the row is still `running`. */
	completedAt: string | null;
}

export interface HeliosRunRow extends CommonRow {
	pInvocId: string;
	modality: 'text' | 'image';
	userPrompt: string;
	plannerParams: unknown;
}

export interface IrisRunRow extends CommonRow {
	pipelineId: string;
	designSessionId: string;
	modality: 'text' | 'image';
	userPrompt: string;
	motifRef: string;
	plannerParams: unknown;
}

export interface AtlasRunRow extends CommonRow {
	pipelineId: string;
	designSessionId: string;
	patternRef: string;
	garmentRef: string;
	/** Holds an `AtlasPlacement`. Named for the column, not for what it means —
	 *  the route returns rows exactly as stored. */
	garmentRegions: unknown;
}

export type RunRow = HeliosRunRow | IrisRunRow | AtlasRunRow;

/**
 * Whether a row records a modality.
 *
 * **Atlas rows do not.** Use this rather than reaching for `row.modality`,
 * which is `undefined` on an Atlas row and silently makes every
 * `find(r => r.modality === 'image')` return nothing.
 */
export function hasModality(row: RunRow): row is HeliosRunRow | IrisRunRow {
	return 'modality' in row;
}

/** `GET /runs` wraps the rows in an object. It is not a bare array. */
export interface RunsResponse {
	runs: RunRow[];
}

/** Whether a parsed body actually looks like the runs envelope. */
export function isRunsResponse(body: unknown): body is RunsResponse {
	return typeof body === 'object' && body !== null && Array.isArray((body as { runs?: unknown }).runs);
}
