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
 */
export async function readGatewayCost(env: Env): Promise<number | null> {
	try {
		const logId = env.AI.aiGatewayLogId;
		if (!logId) {
			return null;
		}
		const log = await env.AI.gateway(env.AI_GATEWAY_ID).getLog(logId);
		return log.cost ?? null;
	} catch {
		return null;
	}
}
