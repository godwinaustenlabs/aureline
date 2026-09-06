import { describe, expect, it } from 'vitest';
import { classifyIris } from './irisOutcome';

const COMPLETED = JSON.stringify({
	pipeline_id: 'run-1',
	design_session_id: 'design-1',
	status: 'completed',
	params: {
		primary_color: 'navy',
		harmony: 'complementary',
		saturation: 'balanced',
		background_treatment: 'solid',
		mood: 'opulent traditional',
		image_prompt: 'Confine the gold to the finest details.',
	},
	image_url: 'https://agent-iris.aureline.workers.dev/images/iris/run-1.jpg',
	width: 512,
	height: 512,
	cost_usd: 0.0019,
	error: null,
});

describe('classifyIris', () => {
	it('reads a completed run', () => {
		const outcome = classifyIris(200, COMPLETED);

		expect(outcome.kind).toBe('run');
		if (outcome.kind !== 'run') return;
		expect(outcome.result.pipeline_id).toBe('run-1');
		expect(outcome.result.params?.primary_color).toBe('navy');
		expect(outcome.result.width).toBe(512);
	});

	/**
	 * The distinction the whole module exists for: a failed Iris run is a 200
	 * that ran, billed and did not work. Calling it an error would hide a run
	 * that cost money.
	 */
	it('treats a failed run as a run, not an error', () => {
		const failed = JSON.stringify({
			pipeline_id: 'run-2',
			design_session_id: 'design-1',
			status: 'failed',
			params: null,
			image_url: null,
			width: null,
			height: null,
			cost_usd: null,
			error: 'image: no such model',
		});

		const outcome = classifyIris(200, failed);

		expect(outcome.kind).toBe('run');
		if (outcome.kind !== 'run') return;
		expect(outcome.result.status).toBe('failed');
		expect(outcome.result.error).toBe('image: no such model');
	});

	/** Something answered, but not the pipeline. Reporting a run would invent one. */
	it('refuses to call a 200 with a wrong body a run', () => {
		const outcome = classifyIris(200, JSON.stringify({ hello: 'world' }));

		expect(outcome.kind).toBe('transport');
	});

	it('refuses to call a 200 with unparseable bytes a run', () => {
		expect(classifyIris(200, 'not json at all').kind).toBe('transport');
	});

	/** A 409 is a precondition. Nothing ran and nothing was billed. */
	it('reads a 409 as a refusal, carrying the reason verbatim', () => {
		const outcome = classifyIris(409, JSON.stringify({ error: 'no run with that id in this session' }));

		expect(outcome.kind).toBe('refusal');
		if (outcome.kind !== 'refusal') return;
		expect(outcome.reason).toBe('no run with that id in this session');
	});

	it('reads a 400 as transport, since it never became a run', () => {
		const outcome = classifyIris(400, JSON.stringify({ error: 'motif_ref: Required' }));

		expect(outcome.kind).toBe('transport');
		if (outcome.kind !== 'transport') return;
		expect(outcome.message).toBe('motif_ref: Required');
		expect(outcome.status).toBe(400);
	});

	it('reads a request that never got an answer', () => {
		const outcome = classifyIris(null, 'could not reach https://iris.test/generate');

		expect(outcome.kind).toBe('transport');
		if (outcome.kind !== 'transport') return;
		expect(outcome.status).toBeNull();
	});

	/** The raw bytes are the point of a debugging console, so every branch keeps them. */
	it('keeps the exact bytes on every branch', () => {
		expect(classifyIris(200, COMPLETED).raw).toBe(COMPLETED);
		expect(classifyIris(500, 'boom').raw).toBe('boom');
	});
});
