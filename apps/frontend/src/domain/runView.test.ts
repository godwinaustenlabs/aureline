import { describe, expect, it } from 'vitest';
import { briefHistory, describeBriefHistory, durationMs, groupRows, isResumable, readLineage } from './runView';
import { heliosImageRow, heliosTextRow } from './rows.fixture';

/**
 * The exact shape a real session ends up in: one original whose image failed,
 * plus two resumes of it that each succeeded. Both resumes are siblings, so both
 * read `attempt: 2` — depth from the original, not a count of tries.
 */
function originalWithTwoSuccessfulResumes() {
	const marker = { root: 'original', resumed_from: 'original', attempt: 2 };

	return groupRows('helios', [
		heliosTextRow({ pInvocId: 'resume-b', createdAt: '2026-08-14T10:58:23.000Z', modelMetadata: { ...marker, planner_skipped: true }, costUsd: null }),
		heliosImageRow({ pInvocId: 'resume-b', createdAt: '2026-08-14T10:58:23.000Z', modelMetadata: { model: '@cf/flux', steps: 4, ...marker } }),
		heliosTextRow({ pInvocId: 'resume-a', createdAt: '2026-08-14T10:55:05.000Z', modelMetadata: { ...marker, planner_skipped: true }, costUsd: null }),
		heliosImageRow({ pInvocId: 'resume-a', createdAt: '2026-08-14T10:55:05.000Z', modelMetadata: { model: '@cf/flux', steps: 4, ...marker } }),
		heliosTextRow({ pInvocId: 'original', createdAt: '2026-08-14T10:39:17.000Z' }),
		heliosImageRow({ pInvocId: 'original', createdAt: '2026-08-14T10:39:17.000Z', status: 'failed', costUsd: null, imageR2Key: null }),
	]);
}

describe('groupRows', () => {
	it('pairs the two rows of one invocation and keeps newest first', () => {
		const groups = groupRows('helios', [
			heliosTextRow({ pInvocId: 'newer', createdAt: '2026-08-14T12:00:00.000Z' }),
			heliosImageRow({ pInvocId: 'newer', createdAt: '2026-08-14T12:00:01.000Z' }),
			heliosTextRow({ pInvocId: 'older', createdAt: '2026-08-14T09:00:00.000Z' }),
			heliosImageRow({ pInvocId: 'older', createdAt: '2026-08-14T09:00:01.000Z' }),
		]);

		expect(groups.map((group) => group.runId)).toEqual(['newer', 'older']);
		expect(groups[0]!.text).not.toBeNull();
		expect(groups[0]!.image).not.toBeNull();
	});

	it('adds both rows up for the real total, which the response never reports', () => {
		const [group] = groupRows('helios', [heliosTextRow({ costUsd: 0.001 }), heliosImageRow({ costUsd: 0.0019008 })]);

		// The response's own cost_usd would have been 0.0019008 alone.
		expect(group!.totalCostUsd).toBeCloseTo(0.0029008, 10);
	});

	it('sums only the rows that recorded a cost', () => {
		const [group] = groupRows('helios', [heliosTextRow({ costUsd: 0.001 }), heliosImageRow({ costUsd: null, status: 'failed' })]);

		expect(group!.totalCostUsd).toBeCloseTo(0.001, 10);
	});

	it('reports null rather than zero when neither row recorded a cost', () => {
		// A null cost means the gateway log was missing, or the call failed before
		// reaching the model and was never charged. $0.00 would be a claim.
		const [group] = groupRows('helios', [heliosTextRow({ costUsd: null, status: 'failed' })]);

		expect(group!.totalCostUsd).toBeNull();
	});

	it('handles a run that failed before the planner produced anything, which has no image row', () => {
		const [group] = groupRows('helios', [heliosTextRow({ status: 'failed', costUsd: null, plannerParams: {} })]);

		expect(group!.image).toBeNull();
		expect(group!.resumable).toBe(false);
	});
});

/** The five legal combinations from docs/helios-runs-conventions.md. */
describe('isResumable', () => {
	it('is true only for a completed text row with a failed image row', () => {
		expect(isResumable('helios', heliosTextRow({ status: 'completed' }), heliosImageRow({ status: 'failed' }))).toBe(true);
	});

	it('is true when the image row is absent entirely', () => {
		expect(isResumable('helios', heliosTextRow({ status: 'completed' }), null)).toBe(true);
	});

	it('is false for a successful run — resuming would pay for a second image', () => {
		expect(isResumable('helios', heliosTextRow({ status: 'completed' }), heliosImageRow({ status: 'completed' }))).toBe(false);
	});

	it('is false while the image is still being generated', () => {
		expect(isResumable('helios', heliosTextRow({ status: 'completed' }), heliosImageRow({ status: 'running' }))).toBe(false);
	});

	it('is false when the planner never succeeded, since there are no params to reuse', () => {
		expect(isResumable('helios', heliosTextRow({ status: 'failed' }), null)).toBe(false);
		expect(isResumable('helios', heliosTextRow({ status: 'running' }), null)).toBe(false);
		expect(isResumable('helios', null, heliosImageRow({ status: 'failed' }))).toBe(false);
	});
});

describe('briefHistory', () => {
	const groups = originalWithTwoSuccessfulResumes();

	it('counts the resumes descending from a brief', () => {
		expect(briefHistory(groups, 'original')).toEqual({ resumesMade: 2, alreadyHasImage: true });
	});

	it('does not count an original as its own resume', () => {
		// Originals carry no `root`, which is exactly what makes them originals.
		expect(briefHistory(groupRows('helios', [heliosTextRow(), heliosImageRow()]), 'invoc-1')).toEqual({ resumesMade: 0, alreadyHasImage: false });
	});

	it('counts a resume that failed, but does not call it an image', () => {
		const marker = { root: 'original', resumed_from: 'original', attempt: 2 };
		const groups = groupRows('helios', [
			heliosTextRow({ pInvocId: 'resume-a', modelMetadata: marker, costUsd: null }),
			heliosImageRow({ pInvocId: 'resume-a', status: 'failed', costUsd: null, imageR2Key: null, modelMetadata: marker }),
			heliosTextRow({ pInvocId: 'original' }),
			heliosImageRow({ pInvocId: 'original', status: 'failed', costUsd: null, imageR2Key: null }),
		]);

		expect(briefHistory(groups, 'original')).toEqual({ resumesMade: 1, alreadyHasImage: false });
	});

	it('leaves the original resumable, because that is what the backend does', () => {
		// The "already has an image" guard reads a run's OWN image row, and the
		// original's is still failed. Hiding the button here would remove a real
		// feature: `skipCache` means another resume is a different picture.
		const original = groups.find((group) => group.runId === 'original');
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
		expect(durationMs(heliosTextRow({ createdAt: '2026-08-14T10:00:00.000Z', completedAt: '2026-08-14T10:00:02.500Z' }))).toBe(2500);
	});

	it('is null while a row is still running, since completed_at is only set on settle', () => {
		expect(durationMs(heliosTextRow({ status: 'running', completedAt: null }))).toBeNull();
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
