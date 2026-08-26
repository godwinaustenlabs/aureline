import {
	AtlasRequestSchema,
	HeliosRequestSchema,
	IrisRequestSchema,
	type AtlasRequest,
	type HeliosRequest,
	type IrisRequest,
} from '@aureline/shared-types';
import type { ZodError } from 'zod';

/**
 * The same schemas the workers validate with, run here first.
 *
 * A 400 round trip costs nothing in money but it costs a wait and it tells the
 * user less than this does, so every request is checked before anything is sent.
 * **The schemas are imported, never reimplemented** — a hand-copied rule drifts
 * the moment the contract moves, and these carry bounds most people would not
 * guess.
 *
 * `sessionId` is **omitted** rather than sent empty when blank, on all three.
 * The schemas require at least one character, so an empty string is a 400 —
 * while an absent field is the documented "use the shared `default` instance".
 */

export type GenerateRequest = HeliosRequest | IrisRequest | AtlasRequest;

export type Validated<T> = { ok: true; request: T } | { ok: false; message: string };

export function validateHeliosGenerate(concept: string, sessionId: string): Validated<HeliosRequest> {
	return check(
		HeliosRequestSchema.safeParse({
			concept,
			...(sessionId ? { session_id: sessionId } : {}),
		}),
	);
}

/**
 * Iris needs the motif to colour and the design it belongs to.
 *
 * `motif_ref` is a **reference the user pastes**, not a file they upload — a URL
 * or an R2 key. The realistic workflow is: run Helios, copy the `image_url` from
 * its result, paste it here.
 *
 * `design_session_id` is required with no fallback. Iris will not mint one, and
 * a run that cannot be traced back to a design is worse than a run that did not
 * happen: it still spends money and still lands in the audit table.
 */
export function validateIrisGenerate(
	concept: string,
	motifRef: string,
	designSessionId: string,
	sessionId: string,
): Validated<IrisRequest> {
	return check(
		IrisRequestSchema.safeParse({
			concept,
			motif_ref: motifRef,
			design_session_id: designSessionId,
			...(sessionId ? { session_id: sessionId } : {}),
		}),
	);
}

/**
 * Atlas needs the coloured pattern, a garment to print it on, and the design.
 *
 * **There is deliberately no free-text field** — Atlas has no text model, so
 * anything free-form would reach a billed image call unvalidated. Everything the
 * caller can ask for is a fixed enum, which is why the controls render from
 * `GarmentTypeSchema.options` and `GarmentRegionSchema.options` rather than from
 * a hand-written list.
 *
 * `garment_ref` is validated as a **URL** where `pattern_ref` is not: there is
 * no upload endpoint this sprint, so a garment is always a link to an already
 * hosted photo, while a pattern may be either a URL or an R2 key.
 */
export function validateAtlasGenerate(
	patternRef: string,
	garmentRef: string,
	designSessionId: string,
	garmentType: string,
	regions: string[],
	coverage: string,
	patternScale: string,
	sessionId: string,
): Validated<AtlasRequest> {
	return check(
		AtlasRequestSchema.safeParse({
			pattern_ref: patternRef,
			garment_ref: garmentRef,
			design_session_id: designSessionId,
			garment_type: garmentType,
			regions,
			coverage,
			pattern_scale: patternScale,
			...(sessionId ? { session_id: sessionId } : {}),
		}),
	);
}

function check<T>(parsed: { success: true; data: T } | { success: false; error: ZodError }): Validated<T> {
	return parsed.success ? { ok: true, request: parsed.data } : { ok: false, message: firstIssueMessage(parsed.error) };
}

/**
 * The first problem in a `ZodError` as one readable line, naming the field.
 *
 * Deliberately a local copy of each worker's `utils.ts`. Those live inside the
 * worker apps rather than a shared package, and moving one would put a backend
 * edit on a frontend branch.
 */
export function firstIssueMessage(zodError: ZodError): string {
	const issue = zodError.issues[0];
	if (!issue) return 'invalid input';
	const field = issue.path.join('.');
	return field ? `${field}: ${issue.message}` : issue.message;
}
