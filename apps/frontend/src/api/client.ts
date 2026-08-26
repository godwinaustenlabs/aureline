import { classify, type CallOutcome } from '../domain/outcome';
import { ENGINE_SPECS, type Engine } from '../domain/engines';
import type { GenerateRequest } from '../domain/validate';
import { isRunsResponse, type RunRow } from './runs';

/**
 * Every request this page makes to the worker. Nothing else calls `fetch`.
 *
 * Three rules hold across all of them, and each is load-bearing:
 *
 * **No credentials.** Nothing authenticates, and the worker never answers
 * `Access-Control-Allow-Credentials`. Sending them would only make the CORS
 * config strictly harder for no benefit.
 *
 * **No retry, no polling, no timeout.** A retry is a decision a person makes by
 * clicking (ADR-0009). There is no `setInterval` anywhere in this app, and no
 * `AbortSignal.timeout` either: aborting a `/generate` does not un-bill it, it
 * just loses the answer we paid for.
 *
 * **`Content-Type` is the only header set.** It is exactly what the worker's
 * `ALLOWED_HEADERS` grants; anything else fails at preflight.
 */

/**
 * How much a call to each billed route costs, for the confirm dialogs.
 *
 * **Per engine, and they differ by more than an order of magnitude.** Iris's
 * image call is about six times Helios's; Atlas does not bill at all yet. A
 * dialog quoting the wrong engine's price is worse than quoting none, so the
 * figures live in `ENGINE_SPECS` beside everything else that differs.
 */
export function generateCostUsd(engine: Engine): number {
	return ENGINE_SPECS[engine].generateCostUsd;
}

export function resumeCostUsd(engine: Engine): number {
	return ENGINE_SPECS[engine].resumeCostUsd;
}

/** Trailing slashes are what people type into a URL field, and `${base}/runs`
 *  with one produces a double slash that routes nowhere. */
export function normaliseBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, '');
}

/**
 * `POST /generate`. Billed.
 *
 * One function and a wider request type, not three — every engine uses the same
 * route names on purpose (iris-05 decision 9), so switching engines is a base
 * URL and a request shape, never a different code path.
 */
export async function generate(engine: Engine, baseUrl: string, request: GenerateRequest): Promise<CallOutcome> {
	return post(engine, `${normaliseBaseUrl(baseUrl)}/generate`, request);
}

/**
 * `POST /resume`. Billed, and refuses with a 409 more often than it runs.
 *
 * The id key differs by engine — Helios shipped before the rename and still
 * says `p_invoc_id`, Iris and Atlas say `pipeline_id` — so the body is built
 * from the spec rather than hardcoded.
 */
export async function resume(engine: Engine, baseUrl: string, runId: string, sessionId: string): Promise<CallOutcome> {
	const body: Record<string, string> = { [ENGINE_SPECS[engine].resumeIdField]: runId };
	if (sessionId) body.session_id = sessionId;

	return post(engine, `${normaliseBaseUrl(baseUrl)}/resume`, body);
}

export type RunsOutcome = { ok: true; rows: RunRow[] } | { ok: false; message: string };

/**
 * `GET /runs`. Free, read-only, and it must stay that way: this is the route the
 * page is allowed to call on load, on every session switch and after every run.
 *
 * `sessionId` picks the Durable Object. Omitting it does not mean "all sessions"
 * — it means the shared instance literally named `default`, which is a real
 * store with a real history.
 *
 * The route also takes a `p_invoc_id` to narrow to a single invocation, and this
 * deliberately does not expose it. The list form already contains those rows, so
 * the page filters in memory instead: selecting a run in the history costs no
 * request at all, and one round trip after a run feeds the scratchpad and the
 * table together.
 */
export async function listRuns(baseUrl: string, sessionId?: string): Promise<RunsOutcome> {
	const url = new URL(`${normaliseBaseUrl(baseUrl)}/runs`);
	if (sessionId) url.searchParams.set('session_id', sessionId);

	const { status, raw } = await send(url.toString(), { method: 'GET' });

	if (status !== 200) {
		return { ok: false, message: status === null ? raw : `GET /runs answered ${status}: ${raw}` };
	}

	let body: unknown;
	try {
		body = JSON.parse(raw) as unknown;
	} catch {
		return { ok: false, message: 'GET /runs answered 200 with a body that is not JSON' };
	}

	// The envelope is `{ runs: [...] }`, not a bare array. Reading it as an array
	// yields an empty history that looks like an empty session.
	return isRunsResponse(body) ? { ok: true, rows: body.runs } : { ok: false, message: 'GET /runs answered without a `runs` array' };
}

/** `GET /`. The connection check, and the cheapest way to find out the base URL
 *  is wrong before spending anything on discovering it. */
export async function ping(baseUrl: string): Promise<{ ok: boolean; message: string }> {
	const { status, raw } = await send(`${normaliseBaseUrl(baseUrl)}/`, { method: 'GET' });
	return status === 200 ? { ok: true, message: raw } : { ok: false, message: status === null ? raw : `HTTP ${status}: ${raw}` };
}

async function post(engine: Engine, url: string, body: unknown): Promise<CallOutcome> {
	const { status, raw } = await send(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

	return classify(engine, status, raw);
}

/**
 * The one place a response is read.
 *
 * The body is taken as **text** and kept that way. The page shows the raw bytes
 * the worker sent, and re-stringifying a parsed object is not the same bytes:
 * key order, spacing and any field this build does not know about all change.
 * Parsing happens afterwards, from this same string.
 *
 * A thrown fetch — DNS, a refused connection, a blocked preflight — comes back
 * as `status: null` rather than an exception, so every caller has one shape to
 * handle.
 */
async function send(url: string, init: RequestInit): Promise<{ status: number | null; raw: string }> {
	try {
		const response = await fetch(url, init);
		return { status: response.status, raw: await response.text() };
	} catch (cause) {
		return { status: null, raw: describeFetchFailure(cause, url) };
	}
}

/**
 * A thrown `fetch` says almost nothing on purpose — the browser will not tell
 * JavaScript that a preflight was refused, because that would leak whether the
 * origin is allowed. The hint is the only useful thing we can add, and it names
 * the two causes that account for nearly all of these.
 */
function describeFetchFailure(cause: unknown, url: string): string {
	const message = cause instanceof Error ? cause.message : String(cause);
	return `could not reach ${url}: ${message}. Either the worker is not running, or this page's origin (${location.origin}) is not in the worker's ALLOWED_ORIGINS — a refused preflight shows as a 403 in the network tab.`;
}
