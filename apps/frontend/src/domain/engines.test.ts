import { describe, expect, it } from 'vitest';
import { classify } from './outcome';
import { ENGINES, ENGINE_SPECS } from './engines';
import { groupRows, isResumable } from './runView';
import { atlasRow, heliosImageRow, heliosTextRow, irisImageRow, irisTextRow } from './rows.fixture';

/**
 * The three ways the engines differ, each one a thing that renders **wrong
 * rather than crashing** if it is got wrong. That is what makes them worth a
 * test: nothing throws, the page just quietly lies.
 */

describe('the run id is not called the same thing on every engine', () => {
	it('reads p_invoc_id on Helios and pipeline_id on the other two', () => {
		expect(ENGINE_SPECS.helios.resultIdField).toBe('p_invoc_id');
		expect(ENGINE_SPECS.iris.resultIdField).toBe('pipeline_id');
		expect(ENGINE_SPECS.atlas.resultIdField).toBe('pipeline_id');
	});

	it('classifies an Atlas result by pipeline_id', () => {
		const body = JSON.stringify({ pipeline_id: 'atlas-1', design_session_id: 'design-1', status: 'completed' });

		const outcome = classify('atlas', 200, body);

		expect(outcome.kind).toBe('run');
		expect(outcome.kind === 'run' && outcome.runId).toBe('atlas-1');
	});

	it('does NOT read an Atlas result as a Helios one', () => {
		// The failure this prevents: checking `p_invoc_id` on an Atlas body finds
		// nothing, the result fails its shape test, and a perfectly good run
		// renders as a transport error.
		const body = JSON.stringify({ pipeline_id: 'atlas-1', status: 'failed', error: 'image: boom' });

		expect(classify('helios', 200, body).kind).toBe('transport');
		expect(classify('atlas', 200, body).kind).toBe('run');
	});

	it('still classifies a Helios result by p_invoc_id', () => {
		const body = JSON.stringify({ p_invoc_id: 'helios-1', status: 'completed' });

		const outcome = classify('helios', 200, body);
		expect(outcome.kind === 'run' && outcome.runId).toBe('helios-1');
	});
});

describe('a failed run is HTTP 200 on every engine', () => {
	it.each(ENGINES)('treats a failed %s run as a run, not an error', (engine) => {
		const body = JSON.stringify({
			[ENGINE_SPECS[engine].resultIdField]: 'run-1',
			status: 'failed',
			error: 'image: the model returned nothing',
		});

		const outcome = classify(engine, 200, body);

		// If this ever becomes `transport`, every failed run renders as a blank
		// success and the page stops telling the truth.
		expect(outcome.kind).toBe('run');
		expect(outcome.kind === 'run' && outcome.result.status).toBe('failed');
	});
});

describe('Atlas writes ONE row per invocation', () => {
	it('groups a single Atlas row into a complete run', () => {
		const groups = groupRows('atlas', [atlasRow()]);

		expect(groups).toHaveLength(1);
		expect(groups[0]!.runId).toBe('atlas-invoc-1');
		// The one row IS the image work, even though nothing on it says so.
		expect(groups[0]!.image).not.toBeNull();
		// And there is no text row — absent by design, not missing.
		expect(groups[0]!.text).toBeNull();
	});

	it('does not total an Atlas cost as NaN', () => {
		// The bug this guards: `rows.find(r => r.modality === 'image')` returns
		// undefined on an Atlas row, and the arithmetic downstream produces NaN,
		// which renders as a backend bug when the backend is fine.
		const withCost = groupRows('atlas', [atlasRow({ costUsd: 0.003 })]);
		expect(withCost[0]!.totalCostUsd).toBe(0.003);

		// And a null cost stays null rather than becoming 0 — "not charged" and
		// "unknown" are different facts.
		expect(groupRows('atlas', [atlasRow()])[0]!.totalCostUsd).toBeNull();
	});

	it('still pairs the two rows on Helios and Iris', () => {
		expect(groupRows('helios', [heliosTextRow(), heliosImageRow()])[0]!.rows).toHaveLength(2);
		expect(groupRows('iris', [irisTextRow(), irisImageRow()])[0]!.rows).toHaveLength(2);
	});

	it('reads the Iris run id off pipelineId, not pInvocId', () => {
		const groups = groupRows('iris', [irisTextRow(), irisImageRow()]);

		expect(groups).toHaveLength(1);
		expect(groups[0]!.runId).toBe('iris-invoc-1');
	});

	it('carries the concept on the engines that take one, and null on Atlas', () => {
		expect(groupRows('iris', [irisTextRow(), irisImageRow()])[0]!.userPrompt).toBe('art deco paisley');
		// Atlas has no free-text field at all — absent, not missing.
		expect(groupRows('atlas', [atlasRow()])[0]!.userPrompt).toBeNull();
	});
});

describe('resumability asks a different question per engine', () => {
	it('offers a resume on a failed Atlas row', () => {
		const failed = groupRows('atlas', [atlasRow({ status: 'failed', imageR2Key: null })]);
		expect(failed[0]!.resumable).toBe(true);
	});

	it('does not offer one on a completed Atlas row', () => {
		// It already has its image; resuming would buy a duplicate nobody asked for.
		expect(groupRows('atlas', [atlasRow()])[0]!.resumable).toBe(false);
	});

	it('needs the planner to have succeeded on a two-row engine', () => {
		// There would be no params to reuse.
		expect(isResumable('helios', heliosTextRow({ status: 'failed' }), null)).toBe(false);
		expect(isResumable('helios', heliosTextRow(), heliosImageRow({ status: 'failed' }))).toBe(true);
	});
});

describe('the costs differ enough that quoting the wrong one matters', () => {
	it('prices an Iris run far above a Helios one', () => {
		// iris-06 measured flux-2-klein at about $0.017 a call. An earlier figure
		// said $0.003 and was wrong by roughly six times; quoting Helios's price
		// on an Iris run repeats that error in the UI.
		expect(ENGINE_SPECS.iris.generateCostUsd).toBeGreaterThan(ENGINE_SPECS.helios.generateCostUsd * 5);
	});

	it('says Atlas costs nothing yet, rather than inventing a figure', () => {
		expect(ENGINE_SPECS.atlas.generateCostUsd).toBe(0);
		// atlas-03 has not run, so there is no measured number to quote.
		expect(ENGINE_SPECS.atlas.costIsEstimated).toMatch(/atlas-03/);
	});
});

describe('each engine has its own base URL', () => {
	it('gives no two engines the same default', () => {
		const urls = ENGINES.map((engine) => ENGINE_SPECS[engine].defaultBaseUrl);

		// Sharing one is the mistake that costs a wrong-engine call: the field
		// still holds the previous engine's URL, Zod strips the unknown keys, and
		// the wrong worker runs a perfectly normal billed generate.
		expect(new Set(urls).size).toBe(urls.length);
	});
});
