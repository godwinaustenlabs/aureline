import type { AtlasRunRow, HeliosRunRow, IrisRunRow } from '../api/runs';

/**
 * Row builders for the tests and for driving the page with no worker running,
 * shaped exactly like `GET /runs` hands them back — camelCase, ISO timestamps,
 * JSON columns as parsed values.
 *
 * Not a `.test.ts` file, so vitest does not collect it.
 *
 * **Note what differs between the three**, because it is the whole reason the
 * history table needs care: Helios says `pInvocId` where the others say
 * `pipelineId`, and **Atlas has one row with no `modality` at all**.
 */

let counter = 0;

const id = () => `row-${++counter}`;

export function heliosTextRow(overrides: Partial<HeliosRunRow> = {}): HeliosRunRow {
	return {
		id: id(),
		pInvocId: 'helios-invoc-1',
		modality: 'text',
		status: 'completed',
		userPrompt: 'art deco paisley',
		plannerParams: { motif_type: 'paisley', style: 'art deco' },
		imageR2Key: null,
		costUsd: 0.001,
		modelMetadata: { model: '@cf/openai/gpt-oss-120b', usage: { total_tokens: 512 } },
		createdAt: '2026-08-14T10:00:00.000Z',
		completedAt: '2026-08-14T10:00:02.000Z',
		...overrides,
	};
}

export function heliosImageRow(overrides: Partial<HeliosRunRow> = {}): HeliosRunRow {
	return {
		id: id(),
		pInvocId: 'helios-invoc-1',
		modality: 'image',
		status: 'completed',
		userPrompt: 'art deco paisley',
		plannerParams: { motif_type: 'paisley', style: 'art deco' },
		imageR2Key: 'patterns/helios-invoc-1.jpg',
		costUsd: 0.0019008,
		modelMetadata: { model: '@cf/black-forest-labs/flux-1-schnell', steps: 8 },
		createdAt: '2026-08-14T10:00:02.000Z',
		completedAt: '2026-08-14T10:00:07.000Z',
		...overrides,
	};
}

export function irisTextRow(overrides: Partial<IrisRunRow> = {}): IrisRunRow {
	return {
		id: id(),
		pipelineId: 'iris-invoc-1',
		designSessionId: 'design-1',
		modality: 'text',
		status: 'completed',
		userPrompt: 'art deco paisley',
		motifRef: 'http://localhost:8787/images/patterns/helios-invoc-1.jpg',
		plannerParams: { primary_color: 'indigo', harmony: 'complementary', mood: 'graphic' },
		imageR2Key: null,
		costUsd: 0.001,
		modelMetadata: { model: '@cf/openai/gpt-oss-120b', usage: { total_tokens: 480 } },
		createdAt: '2026-08-14T11:00:00.000Z',
		completedAt: '2026-08-14T11:00:02.000Z',
		...overrides,
	};
}

export function irisImageRow(overrides: Partial<IrisRunRow> = {}): IrisRunRow {
	return {
		id: id(),
		pipelineId: 'iris-invoc-1',
		designSessionId: 'design-1',
		modality: 'image',
		status: 'completed',
		userPrompt: 'art deco paisley',
		motifRef: 'http://localhost:8787/images/patterns/helios-invoc-1.jpg',
		plannerParams: { primary_color: 'indigo', harmony: 'complementary', mood: 'graphic' },
		imageR2Key: 'iris/iris-invoc-1.jpg',
		// Six times Helios. iris-06 measured it.
		costUsd: 0.017,
		modelMetadata: { model: '@cf/black-forest-labs/flux-2-klein-9b', steps: 4 },
		createdAt: '2026-08-14T11:00:02.000Z',
		completedAt: '2026-08-14T11:00:14.000Z',
		...overrides,
	};
}

/**
 * **One row, and no `modality`.** This fixture is the cheap way to build the
 * history table against a one-row engine, and the regression guard against
 * somebody reintroducing a two-row assumption.
 */
export function atlasRow(overrides: Partial<AtlasRunRow> = {}): AtlasRunRow {
	return {
		id: id(),
		pipelineId: 'atlas-invoc-1',
		designSessionId: 'design-1',
		status: 'completed',
		patternRef: 'http://localhost:8788/images/iris/iris-invoc-1.jpg',
		garmentRef: 'https://example.com/blank-tshirt.jpg',
		garmentRegions: {
			garment_type: 'tshirt',
			regions: ['back', 'hem'],
			coverage: 'allover',
			pattern_scale: 'medium',
			prompt_version: 'atlas-placement-v1',
		},
		imageR2Key: 'atlas/atlas-invoc-1.jpg',
		// The image call is still a fixture, so nothing was billed (atlas-06).
		costUsd: null,
		modelMetadata: { model: '@cf/black-forest-labs/flux-2-klein-9b', steps: null },
		createdAt: '2026-08-14T12:00:00.000Z',
		completedAt: '2026-08-14T12:00:05.000Z',
		...overrides,
	};
}
