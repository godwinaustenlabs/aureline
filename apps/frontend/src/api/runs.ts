import type { HeliosStatus } from '@aureline/shared-types';

/**
 * The `helios_runs` rows as `GET /runs` hands them back.
 *
 * These are Drizzle's own select shape, serialised, and the route deliberately
 * does not reshape them — the point of that route is to show what is actually
 * stored. So the field names are camelCase and the two timestamps arrive as ISO
 * strings rather than the `Date`s the worker holds.
 *
 * Mirrors `apps/agent-helios/src/db/schema.ts`. It is a read model for a debug
 * page rather than a wire contract, which is why it lives here and not in
 * `@aureline/shared-types`: nothing validates against it and nothing else needs
 * to agree with it.
 *
 * **Nothing enforces that mirror, and it has already drifted once.** This
 * interface said `pInvocId` for months after the column and the select were
 * renamed to `pipelineId`. The rows arrive as `unknown` and are asserted into
 * this type at the boundary, so TypeScript could not see it, the fixtures below
 * carried the same stale name, and every test stayed green while the run
 * history read `undefined` for the id it groups by.
 *
 * So: a change to `heliosRuns` in that schema is a change here, in the same
 * commit. The typed half of this page — `HeliosResult` from
 * `@aureline/shared-types` — is checked by the compiler and needs no such note.
 * This half is on the reader.
 */
export interface RunRow {
	id: string;
	pipelineId: string;
	/**
	 * The design this run belongs to, carried unchanged through every engine.
	 *
	 * The one field that ties a Helios pattern to the Iris run that coloured it.
	 * Both engines store it on every row and both `/runs` routes return it — it
	 * was arriving in the JSON and being dropped here, which meant the chain
	 * between the two engines existed in the databases and nowhere on screen.
	 */
	designSessionId: string;
	modality: 'text' | 'image';
	status: HeliosStatus;
	userPrompt: string;
	/**
	 * The R2 key of the motif an Iris run coloured. **Iris only** — `iris_runs`
	 * is `helios_runs` plus this one column, which is also why the two engines
	 * chunk their D1 inserts at 7 rows and 8.
	 *
	 * Optional rather than nullable, because a Helios row does not have the field
	 * at all — `undefined` says "this engine has no such column" where `null`
	 * would say "it has one and it is empty".
	 */
	motifRef?: string;
	/** A JSON column. Typed `unknown` because it reads back untrusted — a row
	 *  written under an older schema must fail loudly rather than render as
	 *  nonsense. Validate with `HeliosParamsSchema` before treating it as params,
	 *  exactly as `services/resume.ts` does. */
	plannerParams: unknown;
	/**
	 * The classifier's answer — `{ mode }` and, on a motif, `{ garment_part }`.
	 *
	 * **Helios only, and its own column rather than a field inside
	 * `plannerParams`.** That separation is what lets the playground group a
	 * design's runs by garment part without parsing a planner output.
	 *
	 * Optional and `unknown` for the same two reasons the fields around it are:
	 * Iris has no such column, and a Helios row written before Phase 2 carries
	 * `{}`. Read it with `readClassification`, never by indexing.
	 */
	classification?: unknown;
	imageR2Key: string | null;
	/** Real dollars, or null when the AI Gateway log was missing. Null is not
	 *  zero: a failed call that never reached the model was never charged. */
	costUsd: number | null;
	/** A JSON column, shape differs by modality. A text row carries
	 *  `{ model, usage }`, an image row `{ model, steps }`, and a resumed row of
	 *  either modality adds `{ root, resumed_from, attempt }`. Untrusted. */
	modelMetadata: unknown;
	createdAt: string;
	/** Null while the row is still `running`. */
	completedAt: string | null;
}

/** `GET /runs` wraps the rows in an object. It is not a bare array. */
export interface RunsResponse {
	runs: RunRow[];
}

/** Whether a parsed body actually looks like the runs envelope. */
export function isRunsResponse(body: unknown): body is RunsResponse {
	return typeof body === 'object' && body !== null && Array.isArray((body as { runs?: unknown }).runs);
}
