import type { RunRow } from '../api/runs';

/**
 * Row builders for the tests, shaped exactly like `GET /runs` hands them back —
 * camelCase, ISO timestamps, JSON columns as parsed values.
 *
 * Not a `.test.ts` file, so vitest does not collect it.
 */

let counter = 0;

export function textRow(overrides: Partial<RunRow> = {}): RunRow {
	return {
		id: `row-${++counter}`,
		pipelineId: 'invoc-1',
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

export function imageRow(overrides: Partial<RunRow> = {}): RunRow {
	return {
		id: `row-${++counter}`,
		pipelineId: 'invoc-1',
		modality: 'image',
		status: 'completed',
		userPrompt: 'art deco paisley',
		plannerParams: { motif_type: 'paisley', style: 'art deco' },
		imageR2Key: 'patterns/invoc-1.jpg',
		costUsd: 0.0019008,
		modelMetadata: { model: '@cf/black-forest-labs/flux-1-schnell', steps: 8 },
		createdAt: '2026-08-14T10:00:02.000Z',
		completedAt: '2026-08-14T10:00:07.000Z',
		...overrides,
	};
}
