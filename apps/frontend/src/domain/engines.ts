/**
 * The three engines, and everything that differs between them.
 *
 * This file exists so the rest of the app reads **data** rather than branching
 * on an engine name in a dozen places. Adding a fourth engine should be one
 * entry here plus its input fields — if it needs an `if (engine === ...)`
 * anywhere else, this table is missing a field.
 *
 * Three differences are load-bearing and each one renders wrong rather than
 * crashing if it is got wrong:
 *
 * 1. **The run-id field is not the same name.** Helios shipped before the
 *    rename and still says `p_invoc_id`; Iris and Atlas say `pipeline_id`
 *    (AGENTS.md section 3). Reading the wrong one gives `undefined`, and a
 *    result that fails its shape check renders as a transport error.
 * 2. **Atlas writes ONE audit row per invocation, not two.** It has a single
 *    billable call and no `modality` column at all (ADR-ATLAS-0001). Code that
 *    assumes a pair returns `undefined` from `rows.find(...)`, totals a cost of
 *    `NaN`, and looks exactly like a backend bug.
 * 3. **The costs differ by more than an order of magnitude.** A confirm dialog
 *    showing another engine's price is worse than showing none.
 */

export const ENGINES = ['helios', 'iris', 'atlas'] as const;

export type Engine = (typeof ENGINES)[number];

export function isEngine(value: unknown): value is Engine {
	return typeof value === 'string' && (ENGINES as readonly string[]).includes(value);
}

export interface EngineSpec {
	id: Engine;
	label: string;
	/** What it produces, for the UI. */
	tagline: string;
	/** Where local dev serves it. Each engine gets its own port. */
	defaultBaseUrl: string;
	/** The run-id key on the JSON result body. */
	resultIdField: 'p_invoc_id' | 'pipeline_id';
	/** The run-id key on a row from `GET /runs`. */
	rowIdField: 'pInvocId' | 'pipelineId';
	/** The key `POST /resume` expects in its body. */
	resumeIdField: 'p_invoc_id' | 'pipeline_id';
	/** How many audit rows one invocation writes. Atlas is the odd one. */
	rowsPerInvocation: 1 | 2;
	/** Real dollars per billed call, for the confirm dialog. */
	generateCostUsd: number;
	resumeCostUsd: number;
	/** Set when the engine is not actually spending yet, so the dialog can say
	 *  so rather than quoting a number nobody has measured. */
	costIsEstimated?: string;
}

export const ENGINE_SPECS: Record<Engine, EngineSpec> = {
	helios: {
		id: 'helios',
		label: 'Helios',
		tagline: 'concept → black-and-white pattern',
		defaultBaseUrl: 'http://localhost:8787',
		// Helios predates the rename and was never migrated. Do not "fix" this to
		// match the other two without changing the worker: it is what Helios
		// actually sends.
		resultIdField: 'p_invoc_id',
		rowIdField: 'pInvocId',
		resumeIdField: 'p_invoc_id',
		rowsPerInvocation: 2,
		// One planner call (~$0.001) plus one Flux Schnell image (~$0.0019).
		generateCostUsd: 0.0029,
		resumeCostUsd: 0.0019,
	},
	iris: {
		id: 'iris',
		label: 'Iris',
		tagline: 'pattern → coloured pattern',
		defaultBaseUrl: 'http://localhost:8788',
		resultIdField: 'pipeline_id',
		rowIdField: 'pipelineId',
		resumeIdField: 'pipeline_id',
		rowsPerInvocation: 2,
		// **Six times Helios.** iris-06 measured flux-2-klein at $0.015 per output
		// megapixel plus $0.002 per input megapixel, so a 1024x1024 output from
		// one small input is about $0.017. An earlier figure in the ticket said
		// $0.003 and was wrong by roughly six times — quoting Helios's price here
		// would understate an Iris run by the same margin.
		generateCostUsd: 0.018,
		resumeCostUsd: 0.017,
	},
	atlas: {
		id: 'atlas',
		label: 'Atlas',
		tagline: 'coloured pattern + garment → placement',
		defaultBaseUrl: 'http://localhost:8789',
		resultIdField: 'pipeline_id',
		rowIdField: 'pipelineId',
		resumeIdField: 'pipeline_id',
		// ONE row. Not two. See the header comment and ADR-ATLAS-0001.
		rowsPerInvocation: 1,
		// The image call is still faked (atlas-06), so a generate genuinely costs
		// nothing today. atlas-03 has not run, so there is no measured figure to
		// quote once it is real — inventing one would be worse than saying so.
		generateCostUsd: 0,
		resumeCostUsd: 0,
		costIsEstimated:
			'Atlas does not bill yet — its image call is still a fixture (atlas-06). ' +
			'The real cost is unmeasured until the atlas-03 probe runs.',
	},
};

/** The run id off a result body, whichever key this engine uses for it. */
export function resultRunId(engine: Engine, result: Record<string, unknown>): string | null {
	const value = result[ENGINE_SPECS[engine].resultIdField];
	return typeof value === 'string' ? value : null;
}

/** The run id off a `GET /runs` row, whichever key this engine uses for it. */
export function rowRunId(engine: Engine, row: Record<string, unknown>): string | null {
	const value = row[ENGINE_SPECS[engine].rowIdField];
	return typeof value === 'string' ? value : null;
}
