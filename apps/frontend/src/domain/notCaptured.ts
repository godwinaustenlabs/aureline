/**
 * The things the scratchpad cannot show, and why.
 *
 * These are rendered as visible rows, always, never silently omitted. An empty
 * box reads as a page bug; a labelled gap reads as an engine gap, which is what
 * each of these is. It also leaves us a list if we later decide to capture them.
 *
 * Reproduced from ticket 09's table verbatim. If one of these ever starts being
 * captured, the row comes out of here in the same commit that adds it.
 */
export interface NotCaptured {
	what: string;
	why: string;
}

export const NOT_CAPTURED: readonly NotCaptured[] = [
	{
		what: "The model's reasoning or thinking",
		why: '`getTextualModelOutput` returns only `{ data, usage, model }` and drops the rest of the reply (packages/shared-utils/src/getTextualModelOutput.ts). Nothing stores it',
	},
	{
		what: 'The planner prompt',
		why: 'Built per call in `prompts/planner.prompt.ts`, never stored or returned',
	},
	{
		what: 'The image prompt sent to Flux',
		why: 'Built per call by `buildImagePrompt`, never stored or returned',
	},
	{
		what: 'Retry attempts inside the planner',
		why: 'The retry loop is internal to `getTextualModelOutput` and reports only the final outcome',
	},
	{
		what: 'Which sessions exist',
		why: 'Durable Objects are addressed by name, not enumerated, and no run row records its session. The picker shows what this browser has used, nothing more',
	},
];
