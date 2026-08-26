import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunHistory } from './RunHistory';
import { groupRows, type RunGroup } from '../domain/runView';
import { heliosImageRow, heliosTextRow } from '../domain/rows.fixture';

/**
 * The history table, rendered. Resume is a billed control, so which rows offer
 * it — and what it warns about — is worth proving at the markup level rather
 * than trusting the props to be wired correctly.
 */
function render(groups: RunGroup[]) {
	return renderToStaticMarkup(
		<RunHistory
			engine="helios"
			groups={groups}
			session="test-plain-cinder-b210"
			loading={false}
			error={null}
			selectedId={null}
			onSelect={() => {}}
			onResume={() => {}}
			onRefresh={() => {}}
			busy={false}
		/>,
	);
}

describe('which rows offer Resume', () => {
	it('offers it on a run whose image failed', () => {
		const markup = render(groupRows('helios', [heliosTextRow(), heliosImageRow({ status: 'failed', costUsd: null, imageR2Key: null })]));
		expect(markup).toContain('Resume');
	});

	it('does not offer it on a run that already succeeded', () => {
		// The backend would refuse this one anyway, but spending a round trip to
		// find that out is worse than not offering the button.
		expect(render(groupRows('helios', [heliosTextRow(), heliosImageRow()]))).not.toContain('>Resume<');
	});

	it('does not offer it when the planner never succeeded', () => {
		const markup = render(groupRows('helios', [heliosTextRow({ status: 'failed', costUsd: null, plannerParams: {} })]));
		expect(markup).not.toContain('>Resume<');
	});
});

describe('what a row shows', () => {
	it('renders an absent image row as absent, not as a blank cell', () => {
		const markup = render(groupRows('helios', [heliosTextRow({ status: 'failed', costUsd: null })]));
		expect(markup).toContain('absent');
	});

	it('renders a missing cost as "not recorded", never as $0.00', () => {
		const markup = render(groupRows('helios', [heliosTextRow({ status: 'failed', costUsd: null })]));
		expect(markup).toContain('not recorded');
		expect(markup).not.toContain('$0.000000');
	});

	it('adds both rows up for the total', () => {
		const markup = render(groupRows('helios', [heliosTextRow({ costUsd: 0.001 }), heliosImageRow({ costUsd: 0.0019008 })]));
		expect(markup).toContain('$0.002901');
	});
});

describe('the resume warning', () => {
	const marker = { root: 'original', resumed_from: 'original', attempt: 2 };

	it('warns when the brief already produced an image elsewhere', () => {
		// A run's own image row stays `failed` forever, so it keeps offering
		// Resume even after a resume of it succeeded. Without this note the button
		// reads as "fix this" when it means "buy another variation".
		const markup = render(
			groupRows('helios', [
				heliosTextRow({ pInvocId: 'resume-a', modelMetadata: marker, costUsd: null }),
				heliosImageRow({ pInvocId: 'resume-a', modelMetadata: { model: '@cf/flux', steps: 4, ...marker } }),
				heliosTextRow({ pInvocId: 'original' }),
				heliosImageRow({ pInvocId: 'original', status: 'failed', costUsd: null, imageR2Key: null }),
			]),
		);

		expect(markup).toContain('already resumed once');
		expect(markup).toContain('variation, not a fix');
	});

	it('says nothing on a brief nobody has resumed', () => {
		const markup = render(groupRows('helios', [heliosTextRow(), heliosImageRow({ status: 'failed', costUsd: null, imageR2Key: null })]));
		expect(markup).toContain('Resume');
		expect(markup).not.toContain('already resumed');
	});
});

describe('an empty session', () => {
	it('explains that pruning is a possible reason, rather than showing a blank table', () => {
		const markup = render([]);
		expect(markup).toContain('No runs in this Durable Object');
		expect(markup).toContain('pruned');
	});
});
