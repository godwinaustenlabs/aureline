import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GarmentRegionSchema, GarmentTypeSchema } from '@aureline/shared-types';
import { EngineFields, type EngineFieldValues } from './EngineFields';
import { RunHistory } from './RunHistory';
import { groupRows } from '../domain/runView';
import { atlasRow, irisImageRow, irisTextRow } from '../domain/rows.fixture';

/**
 * The per-engine inputs, and the history table that has to survive a one-row
 * engine.
 *
 * Rendered to static markup rather than mounted, so these need no DOM and no
 * worker. Every assertion here is about something that would render **wrong
 * rather than crash** — the failure mode that reads as a backend bug.
 */

const values: EngineFieldValues = {
	concept: '',
	motifRef: '',
	patternRef: 'http://localhost:8788/images/iris/x.jpg',
	garmentRef: 'https://example.com/tee.jpg',
	designSessionId: 'design-1',
	garmentType: 'tshirt',
	regions: ['back'],
	coverage: 'allover',
	patternScale: 'medium',
};

const fields = (overrides: Partial<EngineFieldValues> = {}, engine: 'helios' | 'iris' | 'atlas' = 'atlas') =>
	renderToStaticMarkup(
		<EngineFields engine={engine} values={{ ...values, ...overrides }} onChange={() => {}} onCopyFromUpstream={null} />,
	);

const history = (engine: 'iris' | 'atlas', rows: Parameters<typeof groupRows>[1]) =>
	renderToStaticMarkup(
		<RunHistory
			engine={engine}
			groups={groupRows(engine, rows)}
			session="test-session"
			loading={false}
			error={null}
			selectedId={null}
			onSelect={() => {}}
			onResume={() => {}}
			onRefresh={() => {}}
			busy={false}
		/>,
	);

describe('the fields shown depend on the engine', () => {
	it('shows nothing extra for Helios', () => {
		expect(fields({}, 'helios')).toBe('');
	});

	it('asks Iris for a motif reference, not a garment', () => {
		const markup = fields({}, 'iris');

		expect(markup).toContain('Motif image reference');
		expect(markup).not.toContain('Garment photo URL');
	});

	it('asks Atlas for a pattern, a garment and a placement', () => {
		const markup = fields();

		expect(markup).toContain('Coloured pattern reference');
		expect(markup).toContain('Garment photo URL');
		expect(markup).toContain('Regions');
	});

	it('asks every engine but Helios for the design session id', () => {
		expect(fields({}, 'iris')).toContain('Design session id');
		expect(fields()).toContain('Design session id');
	});
});

describe('the controls render from the contract, not a hand-written list', () => {
	it('offers every garment type the schema declares', () => {
		const markup = fields();

		for (const garment of GarmentTypeSchema.options) {
			expect(markup).toContain(`value="${garment}"`);
		}
	});

	it('offers every region the schema declares', () => {
		const markup = fields();

		for (const region of GarmentRegionSchema.options) {
			expect(markup).toContain(region);
		}
	});
});

describe('a garment cannot be asked for a region it does not have', () => {
	it('disables sleeve and neck on a scarf', () => {
		// A scarf is a flat rectangle. Asking anyway does not get ignored — it
		// degrades the whole output, and it still bills.
		const markup = fields({ garmentType: 'scarf', regions: ['front'] });

		expect(markup).toContain('a scarf has no sleeve');
		expect(markup).toContain('a scarf has no neck');
		expect(markup).toContain('check disabled');
	});

	it('disables sleeve on a sleeveless dress', () => {
		expect(fields({ garmentType: 'dress', regions: ['front'] })).toContain('a dress has no sleeve');
	});

	it('leaves all five available on a hoodie', () => {
		expect(fields({ garmentType: 'hoodie', regions: ['front'] })).not.toContain('check disabled');
	});
});

describe('the garment field says it is a link, not an upload', () => {
	it('labels it so nobody clicks expecting a file picker', () => {
		// There is no upload endpoint this sprint. Every person testing this page
		// would otherwise try to attach a photo.
		expect(fields()).toContain('not a file to upload');
	});
});

describe('the history table survives a one-row engine', () => {
	it('drops the text column for Atlas', () => {
		// Atlas has no text stage at all, so a text column would be a column of
		// permanent em-dashes that reads as missing data.
		expect(history('atlas', [atlasRow()])).not.toContain('<th>text</th>');
	});

	it('keeps the text column for Iris', () => {
		expect(history('iris', [irisTextRow(), irisImageRow()])).toContain('<th>text</th>');
	});

	it('heads the id column with the key that engine actually uses', () => {
		expect(history('atlas', [atlasRow()])).toContain('pipeline_id');
	});

	it('never renders a cost as NaN', () => {
		// The headline bug: `rows.find(r => r.modality === 'image')` returns
		// undefined on an Atlas row, and the total comes out NaN.
		expect(history('atlas', [atlasRow({ costUsd: 0.003 })])).not.toContain('NaN');
		expect(history('atlas', [atlasRow()])).not.toContain('NaN');
		expect(history('iris', [irisTextRow(), irisImageRow()])).not.toContain('NaN');
	});

	it('shows an Atlas run as one row rather than half-missing', () => {
		const markup = history('atlas', [atlasRow()]);

		expect(markup).toContain('atlas-in');
		expect(markup).not.toContain('absent');
	});
});
