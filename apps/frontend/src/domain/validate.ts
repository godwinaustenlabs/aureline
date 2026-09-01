import { HeliosRequestSchema, type HeliosRequest } from '@aureline/shared-types';
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

/**
 * Builds the request body, or explains what is wrong with it.
 *
 * `sessionId` is **omitted** rather than sent empty when blank. The schema
 * requires at least one character, so an empty string is a 400 — while an absent
 * field is the documented "use the shared `default` instance".
 */
export function validateGenerate(concept: string, sessionId: string): Validated {
	const parsed = HeliosRequestSchema.safeParse({
		concept,
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
