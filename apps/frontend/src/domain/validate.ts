import { HeliosRequestSchema, IrisRequestSchema, type HeliosRequest, type IrisRequest } from '@aureline/shared-types';
import type { ZodError } from 'zod';

/**
 * The same schema the worker validates with, run here first.
 *
 * A 400 round trip costs nothing in money but it costs a wait and it tells the
 * user less than this does, so the concept is checked before anything is sent.
 * The schema is imported rather than reimplemented — a hand-copied rule drifts
 * the moment the contract moves, and this one already carries a max length most
 * people would not guess.
 */

export type Validated = { ok: true; request: HeliosRequest } | { ok: false; message: string };

export type ValidatedIris = { ok: true; request: IrisRequest } | { ok: false; message: string };

/**
 * Builds the request body, or explains what is wrong with it.
 *
 * `sessionId` is **omitted** rather than sent empty when blank. The schema
 * requires at least one character, so an empty string is a 400 — while an absent
 * field is the documented "use the shared `default` instance".
 *
 * `designSessionId` is **required and never omitted**, which is the difference
 * between the two and the reason they are not handled alike. It is the design's
 * own identity, carried unchanged into Iris and Atlas, and there is no default
 * for it to fall back to.
 *
 * One object rather than three positional strings (AGENTS.md §6). All three are
 * strings, and sending the concept as the design id — or either id as the other
 * — would compile, run, and bill.
 */
export function validateGenerate(input: {
	concept: string;
	designSessionId: string;
	sessionId: string;
}): Validated {
	const { concept, designSessionId, sessionId } = input;

	const parsed = HeliosRequestSchema.safeParse({
		concept,
		design_session_id: designSessionId,
		...(sessionId ? { session_id: sessionId } : {}),
	});

	return parsed.success ? { ok: true, request: parsed.data } : { ok: false, message: firstIssueMessage(parsed.error) };
}

/**
 * The first problem in a `ZodError` as one readable line, naming the field.
 *
 * Deliberately a local copy of `apps/agent-helios/src/utils.ts`. That file is
 * inside the worker app rather than a shared package, and moving it would put an
 * `agent-helios` edit on this branch, which this ticket keeps clean.
 */
export function firstIssueMessage(zodError: ZodError): string {
	const issue = zodError.issues[0];
	if (!issue) return 'invalid input';
	const field = issue.path.join('.');
	return field ? `${field}: ${issue.message}` : issue.message;
}

/**
 * The same, for Iris.
 *
 * `motifRef` is the one field with no Helios counterpart, and it is an **R2 key**
 * — `patterns/{pipeline_id}.jpg` — not a URL. Iris reads the object straight out
 * of the shared bucket; handing it `https://…/images/patterns/x.jpg` fails at the
 * bucket read, after the request has been accepted. `domain/imageUrl.ts` converts
 * between the two.
 *
 * `designSessionId` carries across from the Helios run that made the motif, and
 * that is the entire point of it: same design id in both engines is what makes
 * the pattern and its colouring one design rather than two unrelated runs.
 */
export function validateIrisGenerate(input: {
	concept: string;
	motifRef: string;
	designSessionId: string;
	sessionId: string;
	classification?: { mode: 'tile' | 'motif'; garmentPart?: string | null };
}): ValidatedIris {
	const { concept, motifRef, designSessionId, sessionId, classification } = input;

	const parsed = IrisRequestSchema.safeParse({
		concept,
		motif_ref: motifRef,
		design_session_id: designSessionId,
		...(sessionId ? { session_id: sessionId } : {}),
		...(classification
			? {
					classification: {
						mode: classification.mode,
						...(classification.garmentPart ? { garment_part: classification.garmentPart } : {}),
					},
				}
			: {}),
	});

	return parsed.success ? { ok: true, request: parsed.data } : { ok: false, message: firstIssueMessage(parsed.error) };
}
