import { describeError } from "../utils";

/**
 * How many times a single stage's cost is read before we give up.
 *
 * The Gateway writes its log row as the call finishes, but for an image model
 * the `cost` field is filled in by a step that runs after the response has
 * already been handed back to us. A read on the very next line therefore finds
 * the row present and the cost absent — which is what production run
 * `bdeb3d8b` did: the image row landed with a null cost while the same log
 * showed a cost in the dashboard minutes later.
 *
 * Text calls are priced from token counts and are populated by the first read,
 * so in practice only the image stage ever spends these attempts.
 */
const READ_ATTEMPTS = 3;

/** Waits between attempts, in milliseconds. Roughly 2 seconds in total. */
const READ_BACKOFF_MS = [400, 1600];

/**
 * Reads what a model call actually cost, in real dollars, from the AI Gateway
 * log written by the call that just finished.
 *
 * The Gateway is the only source that speaks dollars. A model's own reply
 * carries either nothing (Flux) or provider-side usage figures in neurons
 * (the planner), and converting neurons ourselves would hardcode a Cloudflare
 * price into our code that drifts silently the day they change it.
 *
 * **Read it immediately after the call it belongs to.** `aiGatewayLogId` holds
 * the most recent routed call on this binding, so a later stage overwrites it.
 * The log id is captured once, up front, for exactly that reason: the retries
 * below must not re-read a property another stage may have moved on.
 *
 * **Only ever call this for a call that actually routed through the gateway.**
 * An ungated call does not clear `aiGatewayLogId` — it leaves whatever the last
 * routed call put there. So calling this after one does not return null; it
 * returns the *previous* stage's cost and attributes it to this one. Helios's
 * image call is ungated whenever it takes the multipart path, and reports its
 * null directly (see `ungatedCallCost` in `imageGenerator.ts`).
 *
 * **Only the last attempt is visible.** When the planner retries, each attempt
 * is its own gateway call and this returns the cost of the final one, not the
 * sum. A run whose planner retried therefore under-reports slightly. The
 * neuron figure it replaced had exactly the same limitation, so this is parity
 * rather than a regression, and both are recorded in
 * docs/helios-runs-conventions.md.
 *
 * A missing, failed or unlogged cost is always tolerated as `null`. Cost is an
 * audit concern and must never fail a run that otherwise worked (ticket 06).
 * Every path to that null logs first, though. The three ways it can happen —
 * no log id, a throw, a log with no cost on it — are indistinguishable from
 * the outside, and a silent null in a cost report reads as a free run.
 *
 * @param stage - Named in the log lines, so a null is attributable to the
 *   planner or the image call without guessing from timestamps.
 */
export async function readGatewayCost(env: Env, stage: "planner" | "image"): Promise<number | null> {
	const logId = env.AI.aiGatewayLogId;
	if (!logId) {
		console.warn(`cost: ${stage} call left no gateway log id`);
		return null;
	}

	const gateway = env.AI.gateway(env.AI_GATEWAY_ID);

	for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
		try {
			const log = await gateway.getLog(logId);
			// Not `?? null`: a genuinely free call costs 0, and 0 is a real answer
			// worth keeping rather than a reason to retry.
			if (typeof log.cost === "number") {
				return log.cost;
			}
			console.warn(`cost: ${stage} log ${logId} carries no cost yet (attempt ${attempt + 1})`);
		} catch (cause) {
			console.warn(`cost: reading ${stage} log ${logId} failed (attempt ${attempt + 1}):`, describeError(cause));
		}

		const backoff = READ_BACKOFF_MS[attempt];
		if (backoff !== undefined) {
			await new Promise((resolve) => setTimeout(resolve, backoff));
		}
	}

	console.warn(`cost: gave up on ${stage} log ${logId} after ${READ_ATTEMPTS} attempts`);
	return null;
}
