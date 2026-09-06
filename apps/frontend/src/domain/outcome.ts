import type { HeliosResult } from '@aureline/shared-types';

/**
 * What one call to the worker turned out to be.
 *
 * Three classes, not two, and the distinction is the whole reason this module
 * exists. Everything downstream branches on `kind`, so the three shapes this API
 * returns are impossible to conflate by accident:
 *
 * - **`run`** — HTTP 200. A pipeline invocation happened and settled. It says
 *   nothing about whether it worked: `result.status` does. There is deliberately
 *   no `success` member on this union, so there is nothing to reach for.
 * - **`refusal`** — HTTP 409. A resume precondition failed. Not an error and not
 *   a run: nothing was written and nothing was billed, and `reason` is a sentence
 *   written to be shown to a person verbatim.
 * - **`transport`** — everything else, including a 400 and a dead network. It
 *   never became a run, so it never has a `pipeline_id`.
 */
export type CallOutcome =
	| { kind: 'run'; result: HeliosResult; raw: string }
	| { kind: 'refusal'; reason: string; raw: string }
	| { kind: 'transport'; message: string; status: number | null; raw: string };

/** The stages `runPipeline` tracks, in the order it runs them. */
export const STAGES = ['persist', 'planner', 'validate', 'image'] as const;

export type Stage = (typeof STAGES)[number];

/**
 * Turns one HTTP answer into an outcome.
 *
 * Split out from the fetch so the classification — the part that is easy to get
 * wrong and expensive when it is — can be tested without a network.
 *
 * **`status` is what decides, never `response.ok`.** A failed Helios run is a
 * 200 carrying `status: "failed"`, so `ok` is true for both halves of the thing
 * this function exists to tell apart. Pass `null` for a request that never got
 * an answer at all.
 */
export function classify(status: number | null, raw: string): CallOutcome {
	if (status === null) {
		return { kind: 'transport', message: raw || 'the request never reached the worker', status: null, raw };
	}

	const body = parseJson(raw);

	if (status === 200) {
		// A 200 whose body is not a result is still a transport failure: something
		// answered, but not the pipeline. Reporting it as a run would invent one.
		return isHeliosResult(body)
			? { kind: 'run', result: body, raw }
			: { kind: 'transport', message: 'the worker answered 200 with a body that is not a HeliosResult', status, raw };
	}

	if (status === 409) {
		// The worker's own sentence, verbatim. Six of them exist and they mean
		// genuinely different things to whoever is holding the failed run, so this
		// must never be replaced with copy of our own.
		return { kind: 'refusal', reason: errorMessage(body) ?? raw, raw };
	}

	return { kind: 'transport', message: errorMessage(body) ?? raw ?? `HTTP ${status}`, status, raw };
}

/**
 * Which stage a failed run died in, off the `stage:` prefix the pipeline puts on
 * `error`. Null when the run did not fail, or when the message carries no prefix
 * this build knows about.
 */
export function failedStage(error: string | null): Stage | null {
	if (!error) return null;
	const prefix = error.slice(0, error.indexOf(':'));
	return (STAGES as readonly string[]).includes(prefix) ? (prefix as Stage) : null;
}

/** A failed run's message with its `stage:` prefix taken off, for showing beside
 *  a stage label rather than repeating it. */
export function failureDetail(error: string | null): string | null {
	if (!error) return null;
	return failedStage(error) ? error.slice(error.indexOf(':') + 1).trim() : error;
}

/** `JSON.parse` that answers `undefined` rather than throwing. */
function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

/** The worker's error envelope is `{ "error": "…" }` on every non-200 it builds. */
function errorMessage(body: unknown): string | null {
	const error = (body as { error?: unknown } | undefined)?.error;
	return typeof error === 'string' && error ? error : null;
}

/**
 * Structural check rather than a Zod schema, because `HeliosResult` is an
 * interface in `@aureline/shared-types` and has no schema to borrow. It checks
 * the fields this page branches on and nothing more — a result carrying an
 * unexpected extra field is still a result.
 */
function isHeliosResult(body: unknown): body is HeliosResult {
	if (typeof body !== 'object' || body === null) return false;
	const candidate = body as Record<string, unknown>;
	return (
		typeof candidate.pipeline_id === 'string' &&
		(candidate.status === 'running' || candidate.status === 'completed' || candidate.status === 'failed')
	);
}
