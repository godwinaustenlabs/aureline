import { describe, expect, it } from 'vitest';
import { classify, failedStage, failureDetail } from './outcome';

/**
 * The three traps at the top of ticket 09, as tests. Each of these is a shape
 * this API produces and a hand-written mock gets wrong.
 */
describe('classify', () => {
	it('reads a 200 carrying status: "failed" as a run, not a success', () => {
		const raw = JSON.stringify({
			pipeline_id: 'abc',
			status: 'failed',
			params: { motif_type: 'paisley' },
			image_url: null,
			cost_usd: null,
			error: 'image: model call failed',
		});

		const outcome = classify(200, raw);

		expect(outcome.kind).toBe('run');
		// The whole point: HTTP said 200, the run still failed, and the caller has
		// to read `status` to find that out.
		expect(outcome.kind === 'run' && outcome.result.status).toBe('failed');
		// A failed run keeps the params the planner produced — that is what makes
		// it resumable.
		expect(outcome.kind === 'run' && outcome.result.params).not.toBeNull();
	});

	it('reads a 200 carrying status: "completed" as the same kind of outcome', () => {
		const outcome = classify(200, JSON.stringify({ pipeline_id: 'abc', status: 'completed', cost_usd: 0.0019 }));

		expect(outcome.kind).toBe('run');
		expect(outcome.kind === 'run' && outcome.result.status).toBe('completed');
	});

	it('reads a 409 as a refusal and keeps the reason verbatim', () => {
		const reason = 'this run already has an image, and resuming would generate and charge for a second one';

		const outcome = classify(409, JSON.stringify({ error: reason }));

		expect(outcome.kind).toBe('refusal');
		expect(outcome.kind === 'refusal' && outcome.reason).toBe(reason);
	});

	it('reads a 400 as transport, since it never became a run', () => {
		const outcome = classify(400, JSON.stringify({ error: 'concept: Too small: expected string to have >=1 characters' }));

		expect(outcome.kind).toBe('transport');
		expect(outcome.kind === 'transport' && outcome.message).toContain('concept:');
		// A 400 never carries a pipeline_id, and this union has nowhere to put one.
		expect(outcome).not.toHaveProperty('result');
	});

	it('reads a network failure, with no status at all, as transport', () => {
		const outcome = classify(null, 'could not reach http://localhost:8787/generate');

		expect(outcome.kind).toBe('transport');
		expect(outcome.kind === 'transport' && outcome.status).toBeNull();
	});

	it('refuses to call a 200 a run when the body is not a HeliosResult', () => {
		// A proxy or a tunnel answering 200 with an HTML error page would otherwise
		// render as a successful run with a blank image.
		const outcome = classify(200, '<!doctype html><title>502</title>');

		expect(outcome.kind).toBe('transport');
	});

	it('keeps the raw body untouched on every branch', () => {
		const raw = '{"pipeline_id":"abc","status":"completed"}';
		expect(classify(200, raw).raw).toBe(raw);
		expect(classify(409, '{"error":"no"}').raw).toBe('{"error":"no"}');
		expect(classify(500, 'boom').raw).toBe('boom');
	});
});

describe('failedStage', () => {
	it('names each of the four stages the pipeline tracks', () => {
		expect(failedStage('persist: storage unavailable')).toBe('persist');
		expect(failedStage('planner: model call failed')).toBe('planner');
		expect(failedStage('validate: motif_type: Required')).toBe('validate');
		expect(failedStage('image: no such model')).toBe('image');
	});

	it('is null for a run that did not fail, and for an unprefixed message', () => {
		expect(failedStage(null)).toBeNull();
		expect(failedStage('something went wrong')).toBeNull();
	});

	it('strips the prefix off the detail but leaves an unprefixed message alone', () => {
		expect(failureDetail('image: no such model')).toBe('no such model');
		// `validate:` failures carry a second colon from the Zod field name, and
		// only the stage prefix comes off.
		expect(failureDetail('validate: motif_type: Required')).toBe('motif_type: Required');
		expect(failureDetail('something went wrong')).toBe('something went wrong');
	});
});
