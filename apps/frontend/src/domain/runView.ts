import { hasModality, type RunRow } from '../api/runs';
import { ENGINE_SPECS, rowRunId, type Engine } from './engines';

/**
 * Turning audit rows into the runs a person thinks in.
 *
 * **How many rows one invocation writes depends on the engine**, and this is the
 * single most breakable assumption in the app:
 *
 * - **Helios and Iris** write two rows sharing a run id, one `text` and one
 *   `image` (ADR-0001) — with one exception, a run that failed before the
 *   planner produced anything, which has a lone `text` row.
 * - **Atlas writes one row, and its table has no `modality` column at all**
 *   (ADR-ATLAS-0001). It has a single billable call, so there is no
 *   partial-success case for a modality to represent.
 *
 * Code that assumes a pair does not crash on an Atlas run. `rows.find(r =>
 * r.modality === 'image')` returns `undefined`, the cost totals to `NaN`, and
 * the run renders as half-missing — which reads as a backend bug when the
 * backend is fine. That is why `hasModality` exists and why nothing below
 * touches `row.modality` directly.
 *
 * Everything here is pure, so the arithmetic that decides what a run cost and
 * whether it can be resumed is testable without a browser or a worker.
 */

/** The three resume markers, out of `model_metadata`. All absent on an original,
 *  which is exactly what makes it an original. */
export interface Lineage {
	/** The run the whole chain descends from. Inherited unchanged however deep. */
	root: string | null;
	/** The immediate parent, so a resume of a resume reads as one more step. */
	resumedFrom: string | null;
	/** Depth from the original, so the first retry is 2. **Not a count** —
	 *  two retries of the same run are siblings that both read 2. */
	attempt: number | null;
}

export interface RunGroup {
	/** The run id, under whichever key this engine uses for it. */
	runId: string;
	engine: Engine;
	/** Every row belonging to this invocation. One for Atlas, two for the rest. */
	rows: RunRow[];
	/** The text row, or null. **Always null for Atlas**, which has no text call
	 *  — not "missing", but genuinely absent by design. */
	text: RunRow | null;
	/** The image row. For Atlas this is the single row, which does the image
	 *  work even though it carries no modality saying so. */
	image: RunRow | null;
	createdAt: string | null;
	/** The caller's concept, on the engines that take one. **Null for Atlas**,
	 *  which has no free-text field at all — not missing, absent by design. */
	userPrompt: string | null;
	/**
	 * The real total across every row this invocation wrote — which is the number
	 * a result body's own `cost_usd` is not, on the two-row engines, because
	 * that one is the image alone.
	 *
	 * Null, never 0, when no row recorded a cost. A null `cost_usd` means the
	 * gateway log was missing or the call never reached the model and was never
	 * charged; rendering that as `$0.00` states a fact we do not have.
	 */
	totalCostUsd: number | null;
	/** Whether `POST /resume` would probably take this one. Deliberately
	 *  approximate: the backend refuses with a 409 and a reason, and showing that
	 *  reason is a perfectly good outcome. */
	resumable: boolean;
	lineage: Lineage;
}

/**
 * Groups rows by invocation, newest first.
 *
 * `listRuns` already orders by `created_at` descending, and a `Map` keeps
 * insertion order, so first appearance is newest first and no re-sort is needed.
 */
export function groupRows(engine: Engine, rows: RunRow[]): RunGroup[] {
	const byInvocation = new Map<string, RunRow[]>();

	for (const row of rows) {
		const id = rowRunId(engine, row as unknown as Record<string, unknown>);
		if (!id) continue; // a row we cannot identify is not a run we can show

		const existing = byInvocation.get(id);
		if (existing) {
			existing.push(row);
		} else {
			byInvocation.set(id, [row]);
		}
	}

	return [...byInvocation.entries()].map(([runId, group]) => toRunGroup(engine, runId, group));
}

function toRunGroup(engine: Engine, runId: string, rows: RunRow[]): RunGroup {
	const singleRow = ENGINE_SPECS[engine].rowsPerInvocation === 1;

	// For a one-row engine the only row IS the image work, even though nothing
	// on it says `modality: "image"`. Reaching for the modality here is exactly
	// the bug this branch exists to prevent.
	const text = singleRow ? null : (rows.find((row) => hasModality(row) && row.modality === 'text') ?? null);
	const image = singleRow ? (rows[0] ?? null) : (rows.find((row) => hasModality(row) && row.modality === 'image') ?? null);

	const costs = rows.map((row) => row.costUsd).filter((cost): cost is number => cost !== null);

	return {
		runId,
		engine,
		rows,
		text,
		image,
		createdAt: text?.createdAt ?? image?.createdAt ?? rows[0]?.createdAt ?? null,
		userPrompt: readUserPrompt(text) ?? readUserPrompt(image),
		totalCostUsd: costs.length === 0 ? null : costs.reduce((total, cost) => total + cost, 0),
		resumable: isResumable(engine, text, image),
		// Read off the image row first: it is the one every cost query reads, and
		// the one a resume marks without fail. On a two-row engine the text row
		// carries the same markers, so it is a safe fallback.
		lineage: readLineage(image?.modelMetadata ?? text?.modelMetadata),
	};
}

/**
 * Whether `POST /resume` would take this run.
 *
 * **Two-row engines:** the planner succeeded, so there are params to reuse, and
 * there is no image yet, so nothing would be paid for twice. An absent image row
 * counts — that is a run that failed while opening it.
 *
 * **Atlas:** there is no planner to have succeeded, so the only question is
 * whether the single row failed. A completed one already has its image and
 * resuming would buy a duplicate nobody asked for.
 */
export function isResumable(engine: Engine, text: RunRow | null, image: RunRow | null): boolean {
	if (ENGINE_SPECS[engine].rowsPerInvocation === 1) {
		return image?.status === 'failed';
	}

	if (text?.status !== 'completed') return false;
	return image === null || image.status === 'failed';
}

/** How long a row took, from its own two timestamps. Null while it is still
 *  running, since `completed_at` is only set when a row settles. */
export function durationMs(row: RunRow | null | undefined): number | null {
	if (!row?.completedAt) return null;
	const started = Date.parse(row.createdAt);
	const finished = Date.parse(row.completedAt);
	return Number.isNaN(started) || Number.isNaN(finished) ? null : finished - started;
}

/**
 * What a brief has already produced, counted over every run descending from it.
 *
 * This exists because `resumable` answers the wrong question on its own. It
 * looks only at a run's **own** rows, so an original whose image failed stays
 * resumable forever — even after two resumes of it have each produced a picture.
 * The button then reads as "fix this broken run" when it actually means "spend
 * again on a brief that already has two images", and nothing on screen tells
 * them apart.
 *
 * Hiding the button would be wrong: `skipCache` is set on every image call, so
 * the same params produce a different picture each time and another resume is a
 * legitimate "give me another variation". The cap exists to budget for exactly
 * that. So this reports what has already been bought and lets the person decide.
 *
 * Counted the way every worker counts it in `countResumeAttempts`: over the rows
 * carrying this run's id as their `root`. Originals carry no `root`, so they are
 * never counted as their own resume.
 */
export interface BriefHistory {
	/** Resumes already made from this brief, successful or not. */
	resumesMade: number;
	/** Whether any of them already produced an image. */
	alreadyHasImage: boolean;
}

export function briefHistory(groups: readonly RunGroup[], runId: string): BriefHistory {
	const descendants = groups.filter((group) => group.image !== null && group.lineage.root === runId);

	return {
		resumesMade: descendants.length,
		alreadyHasImage: descendants.some((group) => group.image?.status === 'completed'),
	};
}

/**
 * How the count reads on screen.
 *
 * **The cap is deliberately not asserted.** `max_resume_attempts` lives in KV
 * and no route exposes it, so naming a limit here would be a guess that goes
 * stale the moment someone edits the dashboard. The backend refuses past it with
 * a 409 and a reason, which is the honest place for that answer to come from.
 */
export function describeBriefHistory({ resumesMade, alreadyHasImage }: BriefHistory): string | null {
	if (resumesMade === 0) return null;

	const times = resumesMade === 1 ? 'once' : `${resumesMade} times`;
	return alreadyHasImage
		? `already resumed ${times}, and this brief already has an image — another resume buys a different variation, not a fix`
		: `already resumed ${times}, without producing an image yet`;
}

/**
 * The resume markers out of a JSON column that reads back as `unknown`.
 *
 * Trusts nothing, the same way the workers' own `resume.ts` trusts nothing:
 * these rows outlive the code that wrote them.
 */
export function readLineage(metadata: unknown): Lineage {
	const fields = asRecord(metadata);
	return {
		root: typeof fields.root === 'string' ? fields.root : null,
		// snake_case on the way in: the workers write these as literal JSON keys.
		resumedFrom: typeof fields.resumed_from === 'string' ? fields.resumed_from : null,
		attempt: typeof fields.attempt === 'number' ? fields.attempt : null,
	};
}

/** The model named on a row, from `model_metadata.model`. */
export function readModel(metadata: unknown): string | null {
	const model = asRecord(metadata).model;
	return typeof model === 'string' ? model : null;
}

/** The steps an image row actually sent, which differs from what config held
 *  whenever config carries a value above the model's cap. */
export function readSteps(metadata: unknown): number | null {
	const steps = asRecord(metadata).steps;
	return typeof steps === 'number' ? steps : null;
}

/** The provider's own token and neuron figures off a text row. Shape is the
 *  provider's business, so it is handed on as-is for rendering as JSON. */
export function readUsage(metadata: unknown): unknown {
	const usage = asRecord(metadata).usage;
	return usage === undefined ? null : usage;
}

/** Whether a text row was written by a resume rather than by the planner. */
export function plannerWasSkipped(metadata: unknown): boolean {
	return asRecord(metadata).planner_skipped === true;
}

/** The concept off a row that has one. Atlas rows do not. */
function readUserPrompt(row: RunRow | null): string | null {
	if (!row || !('userPrompt' in row)) return null;
	return typeof row.userPrompt === 'string' ? row.userPrompt : null;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
