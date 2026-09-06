import { describe, expect, it } from 'vitest';
import {
	briefHistory,
	describeBriefHistory,
	durationMs,
	groupByDesign,
	groupRows,
	isResumable,
	readClassification,
	readLineage,
} from './runView';
import { imageRow, textRow } from './rows.fixture';

/**
 * The exact shape a real session ends up in: one original whose image failed,
 * plus two resumes of it that each succeeded. Both resumes are siblings, so both
 * read `attempt: 2` — depth from the original, not a count of tries.
 */
function originalWithTwoSuccessfulResumes() {
	const marker = { root: 'original', resumed_from: 'original', attempt: 2 };

	return groupRows([
		textRow({ pipelineId: 'resume-b', createdAt: '2026-08-14T10:58:23.000Z', modelMetadata: { ...marker, planner_skipped: true }, costUsd: null }),
		imageRow({ pipelineId: 'resume-b', createdAt: '2026-08-14T10:58:23.000Z', modelMetadata: { model: '@cf/flux', steps: 4, ...marker } }),
		textRow({ pipelineId: 'resume-a', createdAt: '2026-08-14T10:55:05.000Z', modelMetadata: { ...marker, planner_skipped: true }, costUsd: null }),
		imageRow({ pipelineId: 'resume-a', createdAt: '2026-08-14T10:55:05.000Z', modelMetadata: { model: '@cf/flux', steps: 4, ...marker } }),
		textRow({ pipelineId: 'original', createdAt: '2026-08-14T10:39:17.000Z' }),
		imageRow({ pipelineId: 'original', createdAt: '2026-08-14T10:39:17.000Z', status: 'failed', costUsd: null, imageR2Key: null }),
	]);
}

describe('groupRows', () => {
	it('pairs the two rows of one invocation and keeps newest first', () => {
		const groups = groupRows([
			textRow({ pipelineId: 'newer', createdAt: '2026-08-14T12:00:00.000Z' }),
			imageRow({ pipelineId: 'newer', createdAt: '2026-08-14T12:00:01.000Z' }),
			textRow({ pipelineId: 'older', createdAt: '2026-08-14T09:00:00.000Z' }),
			imageRow({ pipelineId: 'older', createdAt: '2026-08-14T09:00:01.000Z' }),
		]);

		expect(groups.map((group) => group.pipelineId)).toEqual(['newer', 'older']);
		expect(groups[0]!.text).not.toBeNull();
		expect(groups[0]!.image).not.toBeNull();
	});

	it('adds both rows up for the real total, which the response never reports', () => {
		const [group] = groupRows([textRow({ costUsd: 0.001 }), imageRow({ costUsd: 0.0019008 })]);

		// The response's own cost_usd would have been 0.0019008 alone.
		expect(group!.totalCostUsd).toBeCloseTo(0.0029008, 10);
	});

	it('sums only the rows that recorded a cost', () => {
		const [group] = groupRows([textRow({ costUsd: 0.001 }), imageRow({ costUsd: null, status: 'failed' })]);

		expect(group!.totalCostUsd).toBeCloseTo(0.001, 10);
	});

	it('reports null rather than zero when neither row recorded a cost', () => {
		// A null cost means the gateway log was missing, or the call failed before
		// reaching the model and was never charged. $0.00 would be a claim.
		const [group] = groupRows([textRow({ costUsd: null, status: 'failed' })]);

		expect(group!.totalCostUsd).toBeNull();
	});

	it('handles a run that failed before the planner produced anything, which has no image row', () => {
		const [group] = groupRows([textRow({ status: 'failed', costUsd: null, plannerParams: {} })]);

		expect(group!.image).toBeNull();
		expect(group!.resumable).toBe(false);
	});
});

/** The five legal combinations from docs/helios-runs-conventions.md. */
describe('isResumable', () => {
	it('is true only for a completed text row with a failed image row', () => {
		expect(isResumable(textRow({ status: 'completed' }), imageRow({ status: 'failed' }))).toBe(true);
	});

	it('is true when the image row is absent entirely', () => {
		expect(isResumable(textRow({ status: 'completed' }), null)).toBe(true);
	});

	it('is false for a successful run — resuming would pay for a second image', () => {
		expect(isResumable(textRow({ status: 'completed' }), imageRow({ status: 'completed' }))).toBe(false);
	});

	it('is false while the image is still being generated', () => {
		expect(isResumable(textRow({ status: 'completed' }), imageRow({ status: 'running' }))).toBe(false);
	});

	it('is false when the planner never succeeded, since there are no params to reuse', () => {
		expect(isResumable(textRow({ status: 'failed' }), null)).toBe(false);
		expect(isResumable(textRow({ status: 'running' }), null)).toBe(false);
		expect(isResumable(null, imageRow({ status: 'failed' }))).toBe(false);
	});
});

describe('briefHistory', () => {
	const groups = originalWithTwoSuccessfulResumes();

	it('counts the resumes descending from a brief', () => {
		expect(briefHistory(groups, 'original')).toEqual({ resumesMade: 2, alreadyHasImage: true });
	});

	it('does not count an original as its own resume', () => {
		// Originals carry no `root`, which is exactly what makes them originals.
		expect(briefHistory(groupRows([textRow(), imageRow()]), 'invoc-1')).toEqual({ resumesMade: 0, alreadyHasImage: false });
	});

	it('counts a resume that failed, but does not call it an image', () => {
		const marker = { root: 'original', resumed_from: 'original', attempt: 2 };
		const groups = groupRows([
			textRow({ pipelineId: 'resume-a', modelMetadata: marker, costUsd: null }),
			imageRow({ pipelineId: 'resume-a', status: 'failed', costUsd: null, imageR2Key: null, modelMetadata: marker }),
			textRow({ pipelineId: 'original' }),
			imageRow({ pipelineId: 'original', status: 'failed', costUsd: null, imageR2Key: null }),
		]);

		expect(briefHistory(groups, 'original')).toEqual({ resumesMade: 1, alreadyHasImage: false });
	});

	it('leaves the original resumable, because that is what the backend does', () => {
		// The "already has an image" guard reads a run's OWN image row, and the
		// original's is still failed. Hiding the button here would remove a real
		// feature: `skipCache` means another resume is a different picture.
		const original = groups.find((group) => group.pipelineId === 'original');
		expect(original?.resumable).toBe(true);
	});
});

describe('describeBriefHistory', () => {
	it('says nothing for a brief that has never been resumed', () => {
		expect(describeBriefHistory({ resumesMade: 0, alreadyHasImage: false })).toBeNull();
	});

	it('warns that a further resume buys a variation rather than a fix', () => {
		const note = describeBriefHistory({ resumesMade: 2, alreadyHasImage: true });
		expect(note).toContain('already resumed 2 times');
		expect(note).toContain('variation, not a fix');
	});

	it('reads differently when the resumes have not produced an image', () => {
		const note = describeBriefHistory({ resumesMade: 1, alreadyHasImage: false });
		expect(note).toContain('once');
		expect(note).toContain('without producing an image yet');
	});

	it('never names a limit, because the cap lives in KV and no route exposes it', () => {
		const note = describeBriefHistory({ resumesMade: 2, alreadyHasImage: true }) ?? '';
		expect(note).not.toMatch(/\b(of 3|limit is|out of)\b/);
	});
});

describe('durationMs', () => {
	it('measures a row from its own two timestamps', () => {
		expect(durationMs(textRow({ createdAt: '2026-08-14T10:00:00.000Z', completedAt: '2026-08-14T10:00:02.500Z' }))).toBe(2500);
	});

	it('is null while a row is still running, since completed_at is only set on settle', () => {
		expect(durationMs(textRow({ status: 'running', completedAt: null }))).toBeNull();
		expect(durationMs(null)).toBeNull();
	});
});

describe('readLineage', () => {
	it('reads the three resume markers out of an untrusted JSON column', () => {
		expect(readLineage({ root: 'r1', resumed_from: 'p1', attempt: 2 })).toEqual({ root: 'r1', resumedFrom: 'p1', attempt: 2 });
	});

	it('is all nulls for an original run, which carries none of the three', () => {
		expect(readLineage({ model: '@cf/x', usage: {} })).toEqual({ root: null, resumedFrom: null, attempt: null });
	});

	it('trusts nothing: wrong types and missing metadata read as absent', () => {
		expect(readLineage({ root: 7, resumed_from: null, attempt: '2' })).toEqual({ root: null, resumedFrom: null, attempt: null });
		expect(readLineage(null)).toEqual({ root: null, resumedFrom: null, attempt: null });
		expect(readLineage('not an object')).toEqual({ root: null, resumedFrom: null, attempt: null });
	});
});

describe('design session id', () => {
	/**
	 * The field is the only thing tying a Helios pattern to the Iris run that
	 * coloured it. It arrives on every row from both engines and used to be
	 * dropped at the type boundary, so nothing on screen could show the chain.
	 */
	it('carries the design id from the rows onto the group', () => {
		const groups = groupRows([
			textRow({ pipelineId: 'run-1', designSessionId: 'design-a' }),
			imageRow({ pipelineId: 'run-1', designSessionId: 'design-a' }),
		]);

		expect(groups[0]?.designSessionId).toBe('design-a');
	});

	/**
	 * Two runs of one design: different pipeline ids, one design id. That pairing
	 * is what the new column exists to show — and it is the distinction AGENTS.md
	 * §3 draws between "the design" and "one run of one engine".
	 *
	 * Rows are fed newest first because that is the only order the engine sends:
	 * `listRuns` orders by `created_at` descending and `groupRows` deliberately
	 * does not re-sort.
	 */
	it('gives two attempts at one design the same design id', () => {
		const groups = groupRows([
			textRow({ pipelineId: 'run-2', designSessionId: 'design-a', createdAt: '2026-08-14T11:00:00.000Z' }),
			imageRow({ pipelineId: 'run-2', designSessionId: 'design-a', createdAt: '2026-08-14T11:00:01.000Z' }),
			textRow({ pipelineId: 'run-1', designSessionId: 'design-a', createdAt: '2026-08-14T10:00:00.000Z' }),
			imageRow({ pipelineId: 'run-1', designSessionId: 'design-a', createdAt: '2026-08-14T10:00:01.000Z' }),
		]);

		expect(groups.map((group) => group.pipelineId)).toEqual(['run-2', 'run-1']);
		expect(groups.every((group) => group.designSessionId === 'design-a')).toBe(true);
	});

	/** A row written before the column existed reads as empty, not as undefined. */
	it('falls back to the image row, then to empty', () => {
		const groups = groupRows([imageRow({ pipelineId: 'run-1', designSessionId: 'design-b' })]);

		expect(groups[0]?.designSessionId).toBe('design-b');
	});
});

describe('readClassification', () => {
	it('reads a tile', () => {
		expect(readClassification({ mode: 'tile' })).toEqual({ mode: 'tile', garmentPart: null });
	});

	it('reads a motif and its garment part, converting the snake_case key', () => {
		// The worker writes `garment_part` as a literal JSON key.
		expect(readClassification({ mode: 'motif', garment_part: 'neckline' })).toEqual({
			mode: 'motif',
			garmentPart: 'neckline',
		});
	});

	it('returns null for a row that was never classified', () => {
		// `{}` is what the column holds before the classifier runs, and on every
		// row written before the column existed. Defaulting to "tile" here would
		// put a decision on screen that nothing made.
		expect(readClassification({})).toBeNull();
		expect(readClassification(undefined)).toBeNull();
		expect(readClassification(null)).toBeNull();
	});

	it('returns null for a mode it does not recognise', () => {
		// A value written under some later schema. Untrusted input from a JSON
		// column, so an unknown mode is "no classification", not a crash.
		expect(readClassification({ mode: 'sticker' })).toBeNull();
		expect(readClassification({ mode: 42 })).toBeNull();
		expect(readClassification('tile')).toBeNull();
	});

	it('drops a non-string garment part rather than rendering it', () => {
		expect(readClassification({ mode: 'motif', garment_part: 7 })).toEqual({
			mode: 'motif',
			garmentPart: null,
		});
	});
});

describe('groupRows and the classification', () => {
	it('reads it off the text row, which is where the classifier writes it', () => {
		const [group] = groupRows([
			textRow({ classification: { mode: 'motif', garment_part: 'cuff' } }),
			imageRow({ classification: { mode: 'motif', garment_part: 'cuff' } }),
		]);

		expect(group.classification).toEqual({ mode: 'motif', garmentPart: 'cuff' });
	});

	it('falls back to the image row when there is no text row', () => {
		const [group] = groupRows([imageRow({ classification: { mode: 'tile' } })]);

		expect(group.classification).toEqual({ mode: 'tile', garmentPart: null });
	});

	it('is null for a run with no classification at all', () => {
		const [group] = groupRows([textRow(), imageRow()]);

		expect(group.classification).toBeNull();
	});
});

describe('groupByDesign', () => {
	it('collects every run of one design into a single group', () => {
		// What design_session_id is for: "show me everything that went into this
		// design" (AGENTS.md §3). Until now the screen only showed the id to be
		// compared by eye between two tables.
		const runs = groupRows([
			textRow({ pipelineId: 'run-a', designSessionId: 'design-1' }),
			imageRow({ pipelineId: 'run-a', designSessionId: 'design-1' }),
			textRow({ pipelineId: 'run-b', designSessionId: 'design-1' }),
			imageRow({ pipelineId: 'run-b', designSessionId: 'design-1' }),
		]);

		const designs = groupByDesign(runs);

		expect(designs).toHaveLength(1);
		expect(designs[0].designSessionId).toBe('design-1');
		expect(designs[0].runs.map((run) => run.pipelineId)).toEqual(['run-a', 'run-b']);
	});

	it('keeps separate designs apart', () => {
		const runs = groupRows([
			textRow({ pipelineId: 'run-a', designSessionId: 'design-1' }),
			textRow({ pipelineId: 'run-b', designSessionId: 'design-2' }),
		]);

		expect(groupByDesign(runs).map((design) => design.designSessionId)).toEqual(['design-1', 'design-2']);
	});

	it('lists the garment parts a design has runs for, in first-seen order', () => {
		// The reason the grouping is worth having: a motif design is built one part
		// at a time, one run each.
		const runs = groupRows([
			textRow({ pipelineId: 'run-a', classification: { mode: 'motif', garment_part: 'neckline' } }),
			textRow({ pipelineId: 'run-b', classification: { mode: 'motif', garment_part: 'cuff' } }),
			textRow({ pipelineId: 'run-c', classification: { mode: 'motif', garment_part: 'neckline' } }),
		]);

		expect(groupByDesign(runs)[0].garmentParts).toEqual(['neckline', 'cuff']);
	});

	it('lists no parts for a design of tiles', () => {
		const runs = groupRows([textRow({ classification: { mode: 'tile' } })]);

		expect(groupByDesign(runs)[0].garmentParts).toEqual([]);
	});

	it('does not collapse rows with no design id into one design', () => {
		// Rows written before the column existed. Bucketing them under "" would
		// present unrelated old runs as a single design, which is a claim rather
		// than an absence of one.
		const runs = groupRows([
			textRow({ pipelineId: 'old-a', designSessionId: '' }),
			textRow({ pipelineId: 'old-b', designSessionId: '' }),
		]);

		expect(groupByDesign(runs)).toHaveLength(2);
	});

	it('totals the cost across every run of the design, and stays null when nothing was charged', () => {
		const charged = groupRows([
			textRow({ pipelineId: 'run-a', costUsd: 0.002 }),
			textRow({ pipelineId: 'run-b', costUsd: 0.003 }),
		]);
		const uncharged = groupRows([textRow({ costUsd: null }), imageRow({ costUsd: null })]);

		expect(groupByDesign(charged)[0].totalCostUsd).toBeCloseTo(0.005);
		// Never 0: a null cost means the gateway log was missing or the call was
		// never charged, and $0.00 states a fact we do not have.
		expect(groupByDesign(uncharged)[0].totalCostUsd).toBeNull();
	});
});
