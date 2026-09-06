import { elapsed } from '../domain/format';

/**
 * A spinner and the elapsed wall clock, and deliberately nothing else.
 *
 * **No stage-by-stage animation.** The pipeline is one synchronous request and
 * nothing exists until everything is done, so any "planning… generating…"
 * sequence here would be invented rather than observed. A spinner that says how
 * long it has been going is the honest amount of information we have.
 */
export function Waiting({ elapsedMs, what }: { elapsedMs: number; what: string }) {
	return (
		<div className="waiting">
			<span className="spinner" aria-hidden="true" />
			<span role="status">
				{what} — {elapsed(elapsedMs)} elapsed. One synchronous request; nothing to show until it settles.
			</span>
		</div>
	);
}
