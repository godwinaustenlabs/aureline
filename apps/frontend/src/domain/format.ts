/**
 * How numbers reach the screen. Kept together so "not recorded" looks the same
 * everywhere it appears, and so nothing renders a missing value as a zero.
 */

/** The placeholder for a value the engine genuinely does not hold. */
export const NOT_RECORDED = 'not recorded';

/**
 * Dollars, at enough precision to be useful.
 *
 * A run costs about $0.0029, so two decimal places would render every cost on
 * this page as `$0.00`. Four significant figures keeps a planner call and an
 * image call distinguishable.
 *
 * **Null is not zero.** A null `cost_usd` means the gateway log was missing, or
 * the call failed before reaching the model and was never charged. `$0.0000`
 * would state a fact we do not have.
 */
export function usd(cost: number | null | undefined): string {
	if (cost === null || cost === undefined) return NOT_RECORDED;
	// Fixed at six places rather than trimmed, so a column of costs lines up and
	// $0.001901 next to $0.001 is obviously the larger of the two.
	return `$${cost.toFixed(6)}`;
}

/** Milliseconds as something readable at both ends of the range: a DO write is
 *  single-digit ms, an image call is several seconds. */
export function duration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined) return NOT_RECORDED;
	if (ms < 1000) return `${Math.round(ms)} ms`;
	return `${(ms / 1000).toFixed(2)} s`;
}

/** A running wall clock, for the spinner. Deliberately coarse — a debug console
 *  wants "this has been going 12 seconds", not a stopwatch. */
export function elapsed(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** An ISO timestamp as local time. The rows carry ISO strings because that is
 *  how the worker serialises its `Date`s. */
export function localTime(iso: string | null | undefined): string {
	if (!iso) return NOT_RECORDED;
	const parsed = new Date(iso);
	return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

/** A `p_invoc_id` short enough for a table cell. The full value is always in the
 *  title attribute and in the raw JSON, so nothing is hidden. */
export function shortId(id: string): string {
	return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/** Pretty JSON for the labelled views. The raw response body is never passed
 *  through this — it is shown exactly as it arrived. */
export function pretty(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}
