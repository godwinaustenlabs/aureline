import type { RunRow } from '../api/runs';

/**
 * Turning `helios_runs` rows into the runs a person thinks in.
 *
 * One invocation is always two rows sharing a `pipeline_id`, one `text` and one
 * `image` (ADR-0001) — with the single exception of a run that failed before the
 * planner produced anything, which has a lone `text` row and no image work to
 * record. Everything here is pure so the arithmetic that decides what a run cost
 * and whether it can be resumed is testable without a browser or a worker.
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
	pipelineId: string;
	/** The design, shared with every other run of it in any engine. Empty only
	 *  for a row written before the column existed. */
	designSessionId: string;
	text: RunRow | null;
	image: RunRow | null;
	/** When the invocation started: the text row's timestamp, or the image row's
	 *  for the rare group that somehow has no text row. */
	createdAt: string | null;
	userPrompt: string;
	/**
	 * The real total across both rows, which is the number the response's own
	 * `cost_usd` is not — that one is the image alone.
	 *
	 * Null, never 0, when neither row recorded a cost. A null `cost_usd` means
	 * the gateway log was missing or the call never reached the model and was
	 * never charged; rendering that as `$0.00` states a fact we do not have.
	 */
	totalCostUsd: number | null;
	/** Whether `POST /resume` would probably take this one. Deliberately
	 *  approximate: the backend refuses with a 409 and a reason, and showing that
	 *  reason is a perfectly good outcome. */
	resumable: boolean;
	lineage: Lineage;
	/**
	 * What the classifier decided, when this is a Helios run that has one.
	 *
	 * Null on an Iris run, on a Helios run from before Phase 2, and on one that
	 * failed before the classifier settled. All three genuinely have no
	 * classification, and null says so where a default `"tile"` would invent one.
	 */
	classification: RunClassification | null;
}

/** The classifier's answer as the screen needs it. */
export interface RunClassification {
	mode: 'tile' | 'motif';
	/** Present on a motif that named a place. Null otherwise, including on every
	 *  tile — a tile covers cloth and has no one part. */
	garmentPart: string | null;
}

/**
 * Groups rows by invocation, newest first.
 *
 * `listRuns` already orders by `created_at` descending, and a `Map` keeps
 * insertion order, so first appearance is newest first and no re-sort is needed.
 */
export function groupRows(rows: RunRow[]): RunGroup[] {
	const byInvocation = new Map<string, RunRow[]>();

	for (const row of rows) {
		const existing = byInvocation.get(row.pipelineId);
		if (existing) {
			existing.push(row);
		} else {
			byInvocation.set(row.pipelineId, [row]);
		}
	}

	return [...byInvocation.entries()].map(([pipelineId, group]) => toRunGroup(pipelineId, group));
}

function toRunGroup(pipelineId: string, rows: RunRow[]): RunGroup {
	const text = rows.find((row) => row.modality === 'text') ?? null;
	const image = rows.find((row) => row.modality === 'image') ?? null;

	const costs = rows.map((row) => row.costUsd).filter((cost): cost is number => cost !== null);

	return {
		pipelineId,
		// Both rows of an invocation carry it, so either will do.
		designSessionId: text?.designSessionId ?? image?.designSessionId ?? '',
		text,
		image,
		createdAt: text?.createdAt ?? image?.createdAt ?? null,
		userPrompt: text?.userPrompt ?? image?.userPrompt ?? '',
		totalCostUsd: costs.length === 0 ? null : costs.reduce((total, cost) => total + cost, 0),
		resumable: isResumable(text, image),
		// Read off the image row first: it is the one every cost query reads, and
		// the one a resume marks without fail. The text row carries the same
		// markers, so it is a safe fallback for a group missing its image row.
		lineage: readLineage(image?.modelMetadata ?? text?.modelMetadata),
		// The text row first: it is the one the classifier writes directly, and the
		// image row only carries a copy. A group missing its text row falls back.
		classification: readClassification(text?.classification ?? image?.classification),
	};
}

/**
 * The one legal combination `POST /resume` recovers: the planner succeeded, so
 * there are params to reuse, and there is no image yet, so nothing would be paid
 * for twice.
 *
 * An absent image row counts. That is a run that failed while opening the row,
 * or one whose image work never started — either way there is no image.
 */
export function isResumable(text: RunRow | null, image: RunRow | null): boolean {
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
 * Counted the way the backend counts it in `countResumeAttempts`: over the image
 * rows carrying this run's id as their `root`. Originals carry no `root`, so
 * they are never counted as their own resume.
 */
export interface BriefHistory {
	/** Resumes already made from this brief, successful or not. */
	resumesMade: number;
	/** Whether any of them already produced an image. */
	alreadyHasImage: boolean;
}

export function briefHistory(groups: readonly RunGroup[], pipelineId: string): BriefHistory {
	const descendants = groups.filter((group) => group.image !== null && group.lineage.root === pipelineId);

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
 * Trusts nothing, the same way `parentMetadata` in the worker's `resume.ts`
 * trusts nothing: these rows outlive the code that wrote them.
 */
export function readLineage(metadata: unknown): Lineage {
	const fields = asRecord(metadata);
	return {
		root: typeof fields.root === 'string' ? fields.root : null,
		// snake_case on the way in: the worker writes these as literal JSON keys.
		resumedFrom: typeof fields.resumed_from === 'string' ? fields.resumed_from : null,
		attempt: typeof fields.attempt === 'number' ? fields.attempt : null,
	};
}

/**
 * Reads the classification out of its column, which arrives untrusted.
 *
 * Returns null for anything that is not a recognised mode — `{}` on a row from
 * before the column existed, a row that failed before classifying, an Iris row
 * that has no column at all, or a value written under some later schema. All of
 * those mean "no classification", and inventing a default here would put a mode
 * on screen that nothing decided.
 */
export function readClassification(value: unknown): RunClassification | null {
	const fields = asRecord(value);

	if (fields.mode !== 'tile' && fields.mode !== 'motif') return null;

	return {
		mode: fields.mode,
		// snake_case on the way in: the worker writes it as a literal JSON key.
		garmentPart: typeof fields.garment_part === 'string' ? fields.garment_part : null,
	};
}

/** The model named on a row, from `model_metadata.model`. */
export function readModel(metadata: unknown): string | null {
	const model = asRecord(metadata).model;
	return typeof model === 'string' ? model : null;
}

/** The steps an image row actually sent, which differs from what config held
 *  whenever config carries a value above Flux Schnell's cap of 8. */
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

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * One design, and every run that went into it.
 *
 * This is what `design_session_id` is for (AGENTS.md §3): "the id that answers
 * 'show me everything that went into this design'". Until now the screen showed
 * it as a value to compare by eye between two tables; this makes it a grouping.
 */
export interface DesignGroup {
	designSessionId: string;
	/** Newest first, in the order `groupRows` produced them. */
	runs: RunGroup[];
	/**
	 * Every garment part this design has runs for, in first-seen order.
	 *
	 * The reason the grouping is worth having: a motif design is built one part
	 * at a time, one run each, and this is what shows the neckline, sleeve and
	 * body runs as one set rather than three unrelated rows.
	 */
	garmentParts: string[];
	/** Null when no run in the design recorded a cost — never 0, for the reason
	 *  `RunGroup.totalCostUsd` is never 0. */
	totalCostUsd: number | null;
}

/**
 * Groups invocations by the design they belong to, newest design first.
 *
 * Runs with no `design_session_id` — rows written before the column existed —
 * are deliberately NOT collapsed into one "" bucket, which would present
 * unrelated old runs as a single design. They each become their own group,
 * keyed by pipeline id, which is the truthful reading of "we do not know what
 * design this belonged to".
 */
export function groupByDesign(groups: RunGroup[]): DesignGroup[] {
	const byDesign = new Map<string, RunGroup[]>();

	for (const group of groups) {
		const key = group.designSessionId === '' ? ` unknown:${group.pipelineId}` : group.designSessionId;
		const existing = byDesign.get(key);
		if (existing) {
			existing.push(group);
		} else {
			byDesign.set(key, [group]);
		}
	}

	return [...byDesign.values()].map((runs) => {
		const costs = runs.map((run) => run.totalCostUsd).filter((cost): cost is number => cost !== null);
		const parts: string[] = [];

		for (const run of runs) {
			const part = run.classification?.garmentPart;
			if (part != null && !parts.includes(part)) parts.push(part);
		}

		return {
			designSessionId: runs[0]?.designSessionId ?? '',
			runs,
			garmentParts: parts,
			totalCostUsd: costs.length === 0 ? null : costs.reduce((total, cost) => total + cost, 0),
		};
	});
}
