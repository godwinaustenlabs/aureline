import { getAgentByName, routeAgentRequest } from "agents";

// The Durable Object class must be exported from the Worker's main module for
// wrangler's `class_name: "HeliosAgent"` binding to resolve.
export { HeliosAgent } from "./agent";

export default {
	/**
	 * Routing only — no request handling or orchestration lives here.
	 *
	 * @param request - The request submitted to the Worker from the client
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 * @returns The response to be sent back to the client
	 */
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);

		if (url.pathname === "/") {
			return new Response("Helios Agent is running", { status: 200 });
		}

		if (url.pathname === "/generate") {
			// The scope key picks which DO instance handles this request (ADR-0005);
			// Sprint 1 has a single caller, so it falls back to a shared instance.
			const agent = await getAgentByName(env.HeliosAgent, await scopeKey(request));
			return agent.fetch(request);
		}

		return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
	},
};

async function scopeKey(request: Request): Promise<string> {
	if (request.method !== "POST") return "default";
	const body = await request.clone().json<{ session_id?: unknown }>().catch(() => undefined);
	const session = body?.session_id;
	return typeof session === "string" && session.trim() ? session.trim() : "default";
}
