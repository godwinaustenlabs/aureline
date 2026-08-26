import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from './App';
import { NOT_CAPTURED } from './domain/notCaptured';

/**
 * A render smoke test, through `react-dom/server` so it needs no DOM.
 *
 * Effects do not run here, which is exactly what makes it safe: this renders the
 * page without making a single request. What it catches is the class of mistake
 * that would otherwise be found by opening the page — a bad import, a hook out
 * of order, a component that throws on its empty state — and the alternative way
 * of finding those is a dev server and, sooner or later, a billed call.
 *
 * `localStorage` does not exist in this environment. That is deliberate rather
 * than stubbed: the loaders are supposed to survive a store that is missing or
 * disabled, and this proves they do.
 */
describe('App', () => {
	const markup = renderToStaticMarkup(<App />);

	it('renders without a DOM, a store or a network', () => {
		expect(markup).toContain('Helios Playground');
	});

	it('warns that a blank session id is the shared default store, not a blank slate', () => {
		expect(markup).toContain('default');
		expect(markup).toContain('An empty id is not');
	});

	it('labels the reference image as discarded before anyone uploads one', () => {
		expect(markup).toContain('Not sent. Discarded in the browser.');
	});

	it('names the cost on the generate button, since every press is real money', () => {
		expect(markup).toContain('$0.002900');
	});

	it('shows the spend tally from the first render', () => {
		expect(markup).toContain('0 billed calls');
	});
});

describe('the not-captured list', () => {
	it('is the ticket 09 table, all five rows', () => {
		expect(NOT_CAPTURED).toHaveLength(5);
		expect(NOT_CAPTURED.map((row) => row.what)).toEqual([
			"The model's reasoning or thinking",
			'The planner prompt',
			'The image prompt sent to Flux',
			'Retry attempts inside the planner',
			'Which sessions exist',
		]);
		// Each carries its reason. A gap with no reason reads as a page bug.
		for (const row of NOT_CAPTURED) expect(row.why.length).toBeGreaterThan(20);
	});
});
