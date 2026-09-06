import { describe, expect, it } from 'vitest';
import type { HeliosResult } from '@aureline/shared-types';
import { buildScratchpad } from './scratchpad';
import { NOT_CAPTURED } from './notCaptured';
import { groupRows } from './runView';
import { imageRow, textRow } from './rows.fixture';

function entries(sections: ReturnType<typeof buildScratchpad>, title: string) {
	const section = sections.find((it) => it.title === title);
	if (!section) throw new Error(`no section titled ${title}`);
	return new Map(section.entries.map((entry) => [entry.label, entry]));
}

const failedResult: HeliosResult = {
	pipeline_id: 'invoc-1',
	design_session_id: 'design-1',
	status: 'failed',
	params: { motif_type: 'paisley' } as HeliosResult['params'],
	image_url: null,
	cost_usd: null,
	error: 'image: no such model',
};

describe('buildScratchpad', () => {
	it('separates the planner cost, the image cost and the real total', () => {
		const [group] = groupRows([textRow({ costUsd: 0.001 }), imageRow({ costUsd: 0.0019008 })]);

		const cost = entries(buildScratchpad({ result: null, group: group!, wallClockMs: null }), 'Cost');

		expect(cost.get('Planner cost')?.value).toBe('$0.001000');
		expect(cost.get('Image cost')?.value).toBe('$0.001901');
		expect(cost.get('Real total')?.value).toBe('$0.002901');
	});

	it('labels the response figure as the image cost, never as the total', () => {
		const sections = buildScratchpad({ result: { ...failedResult, cost_usd: 0.0019008 }, group: null, wallClockMs: 1200 });
		const cost = entries(sections, 'Cost');

		expect([...cost.keys()]).toContain('Image cost, as the response reported it');
		expect([...cost.keys()].some((label) => label.toLowerCase() === 'cost')).toBe(false);
	});

	it('names the stage a failure happened in', () => {
		const outcome = entries(buildScratchpad({ result: failedResult, group: null, wallClockMs: 900 }), 'Outcome');

		expect(outcome.get('Failed at stage')?.value).toBe('image — no such model');
	});

	it('says a completed run did not fail rather than leaving a blank', () => {
		const outcome = entries(
			buildScratchpad({ result: { ...failedResult, status: 'completed', error: null }, group: null, wallClockMs: 900 }),
			'Outcome',
		);

		expect(outcome.get('Failed at stage')?.value).toBe('did not fail');
		expect(outcome.get('Failed at stage')?.missing).toBeUndefined();
	});

	it('renders every "not captured" row, always', () => {
		const sections = buildScratchpad({ result: null, group: null, wallClockMs: null });
		const gaps = entries(sections, 'Not captured by the engine');

		expect(gaps.size).toBe(NOT_CAPTURED.length);
		for (const { what } of NOT_CAPTURED) {
			expect(gaps.get(what)?.missing).toBe(true);
		}
	});

	it('labels the gaps rather than leaving them empty when there are no rows', () => {
		const planner = entries(buildScratchpad({ result: failedResult, group: null, wallClockMs: null }), 'Planner — text row');

		expect(planner.get('Model')?.missing).toBe(true);
		expect(planner.get('Model')?.value).toBe('no stored row for this run');
	});

	it('prefers the stored params over the response copy, and falls through an empty stored object', () => {
		const [withParams] = groupRows([textRow({ plannerParams: { motif_type: 'thistle' } })]);
		expect(entries(buildScratchpad({ result: failedResult, group: withParams!, wallClockMs: null }), 'Params the planner produced')
			.get('plannerParams (stored)')?.json).toEqual({ motif_type: 'thistle' });

		// `{}` is what a text row holds before the planner settles it.
		const [empty] = groupRows([textRow({ plannerParams: {}, status: 'failed' })]);
		expect(entries(buildScratchpad({ result: failedResult, group: empty!, wallClockMs: null }), 'Params the planner produced')
			.get('params (from the response)')?.json).toEqual(failedResult.params);
	});

	it('says a run has no lineage rather than showing three empty markers', () => {
		const [original] = groupRows([textRow(), imageRow()]);
		const lineage = entries(buildScratchpad({ result: null, group: original!, wallClockMs: null }), 'Resume lineage');

		expect(lineage.get('Lineage')?.missing).toBe(true);
	});

	it('shows the markers when the run is part of a resume chain', () => {
		const [resumed] = groupRows([
			textRow({ modelMetadata: { model: '@cf/x', root: 'r1', resumed_from: 'p1', attempt: 2, planner_skipped: true } }),
			imageRow({ modelMetadata: { model: '@cf/flux', steps: 8, root: 'r1', resumed_from: 'p1', attempt: 2 } }),
		]);

		const lineage = entries(buildScratchpad({ result: null, group: resumed!, wallClockMs: null }), 'Resume lineage');

		expect(lineage.get('root')?.value).toBe('r1');
		expect(lineage.get('resumed_from')?.value).toBe('p1');
		expect(lineage.get('attempt')?.value).toBe('2');
	});
});
