import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HeliosResult } from '@aureline/shared-types';
import { ImageOutput } from './ImageOutput';
import { classify, type CallOutcome } from '../domain/outcome';

/**
 * The three outcome shapes, rendered.
 *
 * `domain/outcome.test.ts` proves the classifier tells them apart. This proves
 * the page then *shows* them correctly, which is a different failure mode — a
 * correctly classified failure rendered as a blank success is exactly the bug
 * ticket 09 exists to prevent, and no amount of classifier testing catches it.
 *
 * Through `react-dom/server`, so it needs no DOM and makes no request.
 */

function render(outcome: CallOutcome | null) {
	return renderToStaticMarkup(
		<ImageOutput outcome={outcome} waitingMs={null} onResume={null} resumeBlockedReason={null} resumeNote={null} />,
	);
}

const completed: HeliosResult = {
	p_invoc_id: '849778fa-4917-4d68-b28c-06f86b1c4c3d',
	status: 'completed',
	params: { motif_type: 'paisley' } as HeliosResult['params'],
	image_url: 'https://agent-helios.aureline.workers.dev/images/patterns/849778fa.jpg',
	cost_usd: 0.0019008,
	error: null,
};

describe('a completed run', () => {
	const markup = render({ kind: 'run', result: completed, raw: JSON.stringify(completed) });

	it('renders the image', () => {
		expect(markup).toContain('Run completed');
		expect(markup).toContain('<img');
	});

	it('uses image_url exactly as it arrived, never rebuilt from the base URL field', () => {
		// The worker builds this from its own origin, so it already points at the
		// right host when the two are deployed apart.
		expect(markup).toContain(completed.image_url!);
	});

	it('labels the response figure as the image cost, never as a total', () => {
		expect(markup).toContain('Image cost as reported here');
		expect(markup).toContain('the planner cost is on the text row');
	});
});

describe('a failed run', () => {
	const failed: HeliosResult = {
		...completed,
		status: 'failed',
		image_url: null,
		cost_usd: null,
		error: 'image: 5006: Additional properties not allowed',
	};

	const markup = render({ kind: 'run', result: failed, raw: JSON.stringify(failed) });

	it('renders as failed even though the HTTP code was 200', () => {
		// The trap at the top of ticket 09. A page branching on `response.ok` puts
		// a success banner here.
		expect(markup).toContain('Run failed');
		expect(markup).not.toContain('Run completed');
	});

	it('names the stage that failed', () => {
		expect(markup).toContain('image stage');
		expect(markup).toContain('5006');
	});

	it('renders no image, rather than a broken one', () => {
		expect(markup).not.toContain('<img');
	});
});

describe('a refusal', () => {
	const reason = 'this run already has an image, and resuming would generate and charge for a second one';
	const markup = render(classify(409, JSON.stringify({ error: reason })));

	it('shows the backend sentence verbatim', () => {
		// Six of these exist and they mean different things to whoever is holding
		// the failed run, so the page must never substitute its own wording.
		expect(markup).toContain(reason);
	});

	it('says nothing was written and nothing was billed', () => {
		expect(markup).toContain('nothing was written and nothing was billed');
	});

	it('is neither an error nor a run', () => {
		expect(markup).not.toContain('Run failed');
		expect(markup).not.toContain('Run completed');
		expect(markup).toContain('refusal');
	});
});

describe('a transport error', () => {
	const markup = render(classify(400, JSON.stringify({ error: 'concept: Too small' })));

	it('reports the HTTP code and says it never became a run', () => {
		expect(markup).toContain('HTTP 400');
		expect(markup).toContain('never became a run');
	});

	it('is not shown as a failed run, because no run ever existed', () => {
		expect(markup).not.toContain('Run failed');
	});
});

describe('the raw body', () => {
	it('is rendered on every outcome, byte for byte', () => {
		// Not re-stringified from the parsed object: key order, spacing and any
		// field this build does not know about would all change.
		const odd = '{"status":"completed","p_invoc_id":"abc","unknown_future_field":1}';

		for (const outcome of [classify(200, odd), classify(409, '{"error":"no"}'), classify(500, 'boom')]) {
			expect(render(outcome)).toContain(outcome.raw.replace(/"/g, '&quot;'));
		}
	});
});
