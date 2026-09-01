/**
 * What this page has spent since it loaded.
 *
 * Every submit is real money, on localhost exactly as in production — there is
 * no local simulator for the `AI` binding — so the tally is always on screen
 * rather than tucked away. Pure, and reset by reloading, which is the only reset
 * that would be honest: the dollars are gone either way.
 */

export interface Spend {
	/** Billed calls made. A 409 refusal is not one: nothing was written and
	 *  nothing was billed. */
	calls: number;
	usd: number;
	/**
	 * Whether `usd` is the floor rather than the figure.
	 *
	 * True once any call's real cost could not be read back — the follow-up
	 * `GET /runs` failed, or the gateway recorded no cost — in which case the
	 * total is what we can prove was spent, not what was.
	 */
	approximate: boolean;
}

export const NO_SPEND: Spend = { calls: 0, usd: 0, approximate: false };

/**
 * Adds one billed call.
 *
 * `amount` should be the **real total** across both rows, from `GET /runs`. Pass
 * null when it could not be read: the call still counts, and the total is marked
 * approximate rather than quietly under-reporting.
 */
export function recordCall(spend: Spend, amount: number | null): Spend {
	return {
		calls: spend.calls + 1,
		usd: spend.usd + (amount ?? 0),
		approximate: spend.approximate || amount === null,
	};
}
