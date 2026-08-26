import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Scratchpad } from './Scratchpad';
import { buildScratchpad } from '../domain/scratchpad';
import { groupRows } from '../domain/runView';
import { heliosImageRow, heliosTextRow } from '../domain/rows.fixture';
import { NOT_CAPTURED } from '../domain/notCaptured';

/**
 * `domain/scratchpad.test.ts` proves the right rows are built. This proves they
 * reach the screen, and — the part that matters — that a labelled gap is
 * visibly different from a value rather than collapsing into an empty cell.
 */
const [group] = groupRows('helios', [heliosTextRow({ costUsd: 0.001 }), heliosImageRow({ costUsd: 0.0019008 })]);
const markup = renderToStaticMarkup(
	<Scratchpad sections={buildScratchpad({ engine: 'helios', runId: null, result: null, group: group!, wallClockMs: 1200 })} waitingMs={null} />,
);

describe('the scratchpad', () => {
	it('shows the three cost figures separately', () => {
		expect(markup).toContain('Planner cost');
		expect(markup).toContain('Image cost');
		expect(markup).toContain('Real total');
		expect(markup).toContain('$0.002901');
	});

	it('marks a gap with its own styling, so it never reads as an empty box', () => {
		expect(markup).toContain('class="missing"');
	});

	it('lists every "not captured" row with its reason', () => {
		// Escaped the way React escapes it — "The model's reasoning" reaches the
		// markup carrying `&#x27;` rather than an apostrophe.
		for (const { what } of NOT_CAPTURED) expect(markup).toContain(what.replace(/'/g, '&#x27;'));
		expect(markup).toContain('engine gaps, not page bugs');
	});

	it('renders stored JSON as a block rather than inline text', () => {
		expect(markup).toContain('<pre>');
		expect(markup).toContain('motif_type');
	});
});

describe('while a run is in flight', () => {
	const waiting = renderToStaticMarkup(<Scratchpad sections={null} waitingMs={4200} />);

	it('shows the elapsed wall clock and no invented progress', () => {
		expect(waiting).toContain('4.2s');
		expect(waiting).toContain('nothing to show until it settles');
	});
});
