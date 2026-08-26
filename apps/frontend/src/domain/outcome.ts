import { ENGINE_SPECS, type Engine } from './engines';

/**
 * What one call to a worker turned out to be.
 *
 * Three classes, not two, and the distinction is the whole reason this module
 * exists. Everything downstream branches on `kind`, so the three shapes these
 * APIs return are impossible to conflate by accident:
 *
 * - **`run`** — HTTP 200. A pipeline invocation happened and settled. It says
 *   nothing about whether it worked: `result.status` does. There is deliberately
 *   no `success` member on this union, so there is nothing to reach for.
 * - **`refusal`** — HTTP 409. A resume precondition failed. Not an error and not
 *   a run: nothing was written and nothing was billed, and `reason` is a sentence
 *   written to be shown to a person verbatim.
 * - **`transport`** — everything else, including a 400, a 501 and a dead
 *   network. It never became a run, so it never has a run id.
 */

/**
 * A settled run from any engine.
 *
 * Deliberately loose. The three engines return genuinely different bodies
 * (`params` vs `placement`, `p_invoc_id` vs `pipeline_id`, Atlas adds
 * `width`/`height`), and this page's job is to show what came back rather than
 * to re-assert a contract the workers already enforce. The raw JSON is always
 * on screen beside it.
 */
export interface RunResult {
	status: 'running' | 'completed' | 'failed';
	image_url?: string | null;
	error?: string | null;
	cost_usd?: number | null;
	width?: number | null;
	height?: number | null;
	design_session_id?: string | null;
	[key: string]: unknown;
}

export type CallOutcome =
	| { kind: 'run'; result: RunResult; runId: string; raw: string }
	| { kind: 'refusal'; reason: string; raw: string }
	| { kind: 'transport'; message: string; status: number | null; raw: string };

/**
 * The stages each engine's pipeline tracks, in the order it runs them.
 *
 * Atlas has no planner stage at all — it has one billable call and no text
 * model — so its list is shorter, and `fetch`/`compose` never appear on the
 * others.
 */
export const STAGES_BY_ENGINE: Record<Engine, readonly string[]> = {
	helios: ['persist', 'planner', 'validate', 'image'],
	iris: ['persist', 'planner', 'validate', 'image'],
	atlas: ['persist', 'validate', 'image'],
};

/**
 * Turns one HTTP answer into an outcome.
 *
 * Split out from the fetch so the classification — the part that is easy to get
 * wrong and expensive when it is — can be tested without a network.
 *
 * **`status` is what decides, never `response.ok`.** A failed run is a 200
 * carrying `status: "failed"`, so `ok` is true for both halves of the thing this
 * function exists to tell apart. Pass `null` for a request that never got an
 * answer at all.
 *
 * `engine` is needed because the run id is not called the same thing on every
 * engine: Helios shipped before the rename and still says `p_invoc_id`, Iris and
 * Atlas say `pipeline_id`. Checking the wrong key makes a perfectly good result
 * fail its shape test and render as a transport error.
 */
export function classify(engine: Engine, status: number | null, raw: string): CallOutcome {
	if (status === null) {
		return { kind: 'transport', message: raw || 'the request never reached the worker', status: null, raw };
	}

	const body = parseJson(raw);

	if (status === 200) {
		const runId = runIdOf(engine, body);

		// A 200 whose body is not a result is still a transport failure: something
		// answered, but not the pipeline. Reporting it as a run would invent one.
		return runId && isRunResult(body)
			? { kind: 'run', result: body, runId, raw }
			: {
					kind: 'transport',
					message: `the worker answered 200 with a body that is not a settled ${ENGINE_SPECS[engine].label} result`,
					status,
					raw,
				};
	}

	if (status === 409) {
		// The worker's own sentence, verbatim. They mean genuinely different
		// things to whoever is holding the failed run, so this must never be
		// replaced with copy of our own.
		return { kind: 'refusal', reason: errorMessage(body) ?? raw, raw };
	}

	return { kind: 'transport', message: errorMessage(body) ?? raw ?? `HTTP ${status}`, status, raw };
}

/** The run id, under whichever key this engine uses. */
function runIdOf(engine: Engine, body: unknown): string | null {
	if (typeof body !== 'object' || body === null) return null;
	const value = (body as Record<string, unknown>)[ENGINE_SPECS[engine].resultIdField];
	return typeof value === 'string' && value ? value : null;
}

/**
 * Structural check rather than a Zod parse.
 *
 * It checks only what this page branches on. A result carrying an extra field
 * this build has never heard of is still a result — and the raw body is on
 * screen regardless, which is the actual contract with whoever is debugging.
 */
function isRunResult(body: unknown): body is RunResult {
	if (typeof body !== 'object' || body === null) return false;
	const status = (body as Record<string, unknown>).status;
	return status === 'running' || status === 'completed' || status === 'failed';
}

/**
 * Which stage a failed run died in, off the `stage:` prefix the pipeline puts on
 * `error`. Null when the run did not fail, or when the message carries no prefix
 * this engine knows about.
 */
export function failedStage(engine: Engine, error: string | null | undefined): string | null {
	if (!error) return null;
	const prefix = error.slice(0, error.indexOf(':'));
	return STAGES_BY_ENGINE[engine].includes(prefix) ? prefix : null;
}

/** A failed run's message with its `stage:` prefix taken off, for showing beside
 *  a stage label rather than repeating it. */
export function failureDetail(engine: Engine, error: string | null | undefined): string | null {
	if (!error) return null;
	return failedStage(engine, error) ? error.slice(error.indexOf(':') + 1).trim() : error;
}

/** `JSON.parse` that answers `undefined` rather than throwing. */
function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

/** Every worker's error envelope is `{ "error": "…" }` on every non-200. */
function errorMessage(body: unknown): string | null {
	const error = (body as { error?: unknown } | undefined)?.error;
	return typeof error === 'string' && error ? error : null;
}
