import type { HeliosResult } from '@aureline/shared-types';
import { failedStage, failureDetail } from './outcome';
import { NOT_CAPTURED } from './notCaptured';
import { duration, localTime, NOT_RECORDED, usd } from './format';
import { durationMs, plannerWasSkipped, readModel, readSteps, readUsage, type RunGroup } from './runView';

/**
 * The debugging surface, assembled from what the engine actually stored.
 *
 * **Reconstructed, not streamed.** The pipeline is one synchronous request and
 * nothing exists until everything is done, so this fills in once, after the
 * response, from a follow-up `GET /runs`. There is no stage-by-stage animation
 * to be had and faking one would be a lie about what the engine is doing.
 *
 * Pure: a result and some rows in, rows of text out. All of the arithmetic that
 * is easy to get wrong — the real total, the per-stage durations, which stage
 * failed — happens here where it can be tested for free.
 */

export interface ScratchpadEntry {
	label: string;
	/** Already formatted for display. `missing` entries carry their reason here. */
	value: string;
	/** Rendered as a JSON block rather than inline text. */
	json?: unknown;
	/**
	 * A labelled gap rather than a value. Two different things wear this: a value
	 * the engine never captures, and one it does capture but that this particular
	 * run has no rows for. Both are better shown than left blank.
	 */
	missing?: boolean;
}

export interface ScratchpadSection {
	title: string;
	/** Shown under the title when the whole section needs a caveat. */
	note?: string;
	entries: ScratchpadEntry[];
}

export interface ScratchpadInput {
	/** The settled result, if a run happened at all. */
	result: HeliosResult | null;
	/** This invocation's rows, from `GET /runs`. Null when that call failed, or
	 *  when the Durable Object no longer holds them. */
	group: RunGroup | null;
	/** Measured in the browser, wall to wall around the POST. */
	wallClockMs: number | null;
	/** Why `group` is null, when it is. */
	rowsUnavailableReason?: string;
}

/** The gap text used wherever an answer depended on rows this run does not have. */
const NO_ROWS = 'no stored row for this run';

export function buildScratchpad({ result, group, wallClockMs, rowsUnavailableReason }: ScratchpadInput): ScratchpadSection[] {
	const text = group?.text ?? null;
	const image = group?.image ?? null;

	return [
		{
			title: 'Outcome',
			note: rowsUnavailableReason,
			entries: [
				entry('Result status', result ? result.status : null, 'no result on screen'),
				stageEntry(result),
				entry('Client wall clock', wallClockMs === null ? null : duration(wallClockMs), 'not measured'),
				entry('p_invoc_id', result?.p_invoc_id ?? group?.pInvocId ?? null, 'no run'),
				entry('Concept sent', group?.userPrompt || null, NO_ROWS),
			],
		},
		{
			title: 'Planner — text row',
			entries: [
				entry('Row status', text?.status ?? null, NO_ROWS),
				entry('Model', readModel(text?.modelMetadata), NO_ROWS),
				jsonEntry('Token usage', text ? readUsage(text.modelMetadata) : undefined, NO_ROWS),
				entry('Duration', text ? duration(durationMs(text)) : null, NO_ROWS),
				entry('Cost', text ? usd(text.costUsd) : null, NO_ROWS),
				...(plannerWasSkipped(text?.modelMetadata)
					? [
							{
								label: 'Planner skipped',
								value: 'this row was written by a resume, so no planner ran and it carries no cost of its own',
							},
						]
					: []),
			],
		},
		{
			title: 'Image — image row',
			entries: [
				entry('Row status', image?.status ?? null, group ? 'no image row: the run never reached the image stage' : NO_ROWS),
				entry('Model', readModel(image?.modelMetadata), NO_ROWS),
				entry('Resolved steps', readSteps(image?.modelMetadata)?.toString() ?? null, NO_ROWS),
				entry('Duration', image ? duration(durationMs(image)) : null, NO_ROWS),
				entry('Cost', image ? usd(image.costUsd) : null, NO_ROWS),
				entry('R2 key', image?.imageR2Key ?? null, 'no image was saved'),
			],
		},
		{
			title: 'Cost',
			note: 'The response carries the image cost only. The real total is the two rows added up.',
			entries: [
				entry('Planner cost', text ? usd(text.costUsd) : null, NO_ROWS),
				entry('Image cost', image ? usd(image.costUsd) : null, NO_ROWS),
				entry('Real total', group ? usd(group.totalCostUsd) : null, NO_ROWS),
				entry('Image cost, as the response reported it', result ? usd(result.cost_usd) : null, 'no result on screen'),
			],
		},
		{
			title: 'Params the planner produced',
			entries: [paramsEntry(result, group)],
		},
		{
			title: 'Timestamps',
			entries: [
				entry('Text row created', text ? localTime(text.createdAt) : null, NO_ROWS),
				entry('Text row completed', text ? localTime(text.completedAt) : null, NO_ROWS),
				entry('Image row created', image ? localTime(image.createdAt) : null, NO_ROWS),
				entry('Image row completed', image ? localTime(image.completedAt) : null, NO_ROWS),
			],
		},
		lineageSection(group),
		{
			title: 'Not captured by the engine',
			note: 'These are engine gaps, not page bugs. Each would need a pipeline change to capture.',
			entries: NOT_CAPTURED.map(({ what, why }) => ({ label: what, value: why, missing: true })),
		},
	];
}

/**
 * The resume markers, shown as a section only when this run is part of a chain.
 * An original carries none of the three, and rendering three empty rows on every
 * ordinary run would be noise rather than information.
 */
function lineageSection(group: RunGroup | null): ScratchpadSection {
	const lineage = group?.lineage;

	if (!lineage || (lineage.root === null && lineage.resumedFrom === null && lineage.attempt === null)) {
		return {
			title: 'Resume lineage',
			entries: [
				{
					label: 'Lineage',
					value: 'none — this is an original run, not a resume. Originals carry no root, resumed_from or attempt.',
					missing: true,
				},
			],
		};
	}

	return {
		title: 'Resume lineage',
		note: 'Use root, not attempt, to answer anything about a brief: two retries of the same run are siblings that both read the same attempt.',
		entries: [
			entry('root', lineage.root, 'absent'),
			entry('resumed_from', lineage.resumedFrom, 'absent'),
			entry('attempt', lineage.attempt?.toString() ?? null, 'absent'),
		],
	};
}

/**
 * Which stage a failure happened in, off the `stage:` prefix on `error`.
 *
 * A completed run gets an explicit "did not fail" rather than a blank, so the
 * absence of a stage reads as an answer instead of as a missing value.
 */
function stageEntry(result: HeliosResult | null): ScratchpadEntry {
	if (!result) return { label: 'Failed at stage', value: 'no result on screen', missing: true };
	if (result.status !== 'failed') return { label: 'Failed at stage', value: 'did not fail' };

	const stage = failedStage(result.error);
	const detail = failureDetail(result.error);

	return {
		label: 'Failed at stage',
		value: stage ? `${stage} — ${detail}` : (detail ?? 'failed with no error message'),
	};
}

/**
 * The params, preferring what is stored over what was returned.
 *
 * The stored copy is the one a resume would actually reuse. It is `{}` on a text
 * row that never got past the planner, which is why an empty object falls
 * through to the result's own `params` rather than rendering as `{}`.
 */
function paramsEntry(result: HeliosResult | null, group: RunGroup | null): ScratchpadEntry {
	const stored = group?.text?.plannerParams;

	if (isNonEmptyObject(stored)) return { label: 'plannerParams (stored)', value: '', json: stored };
	if (result?.params) return { label: 'params (from the response)', value: '', json: result.params };

	return {
		label: 'Params',
		value: 'the planner never produced any, so there is nothing to reuse and nothing to resume',
		missing: true,
	};
}

function isNonEmptyObject(value: unknown): boolean {
	return typeof value === 'object' && value !== null && Object.keys(value as object).length > 0;
}

/** A plain row, or a labelled gap carrying `whenMissing` as its reason. */
function entry(label: string, value: string | null | undefined, whenMissing: string): ScratchpadEntry {
	if (value === null || value === undefined || value === '' || value === NOT_RECORDED) {
		return { label, value: value === NOT_RECORDED ? NOT_RECORDED : whenMissing, missing: true };
	}
	return { label, value };
}

/** A row rendered as JSON, or a labelled gap when there is nothing to render. */
function jsonEntry(label: string, value: unknown, whenMissing: string): ScratchpadEntry {
	if (value === undefined || value === null) return { label, value: whenMissing, missing: true };
	return { label, value: '', json: value };
}
