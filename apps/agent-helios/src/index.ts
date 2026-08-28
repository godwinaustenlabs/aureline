import { getAgentByName, routeAgentRequest } from "agents";
import { readPatternImage } from "./repository/r2.repository";
import { preflight, withCors } from "./cors";

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
		// Ahead of routing: a preflight is a question about permission, not a
		// request for the route it names, and `/generate` would reject the empty
		// body of one long before CORS ever got a say.
		if (request.method === "OPTIONS") {
			return preflight(request, env);
		}

		// Every route, not the three the playground posts to. `/` is its connection
		// check, `/images/*` is a fetch the moment anyone wants the bytes rather
		// than an `<img>`, and a 404 that fails at CORS instead of reporting itself
		// is a 404 nobody can debug.
		return withCors(await route(request, env), request, env);
	},
};

/** Path dispatch. CORS is the caller's job, so nothing below thinks about it. */
async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);

	if (url.pathname === "/") {
		return new Response("Helios Agent is running", { status: 200 });
	}

	if (url.pathname === "/generate" || url.pathname === "/resume" || url.pathname === "/runs") {
		// The scope key picks which DO instance handles this request (ADR-0005);
		// Sprint 1 has a single caller, so it falls back to a shared instance.
		// `/resume` and `/runs` route by the same rule deliberately: a run can
		// only be resumed or read from the DO that holds it, so both have to
		// land where the original `/generate` did.
		const agent = await getAgentByName(env.HeliosAgent, await scopeKey(request));
		return agent.fetch(request);
	}

	if (url.pathname.startsWith("/images/")) {
		// Everything after "/images/" is the R2 key, e.g. "patterns/{pipeline_id}.jpg"
		const key = url.pathname.slice("/images/".length);
		const object = await readPatternImage(env.PATTERNS, key);

		if (!object) {
			return new Response("Not found", { status: 404 });
		}

		return new Response(object.body, {
			headers: { "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream" },
		});
	}

	return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
}

/**
 * Which Durable Object serves this request (ADR-0005).
 *
 * A POST carries its session in the JSON body, a GET has no body at all and
 * carries it in the query string. Both are read, because a GET falling through
 * to the shared `default` instance would report an empty history for every
 * named session while looking like it worked.
 */
async function scopeKey(request: Request): Promise<string> {
	if (request.method !== "POST") {
		return normaliseSession(new URL(request.url).searchParams.get("session_id"));
	}

	const body = await request.clone().json<{ session_id?: unknown }>().catch(() => undefined);
	return normaliseSession(body?.session_id);
}

/** A usable session name, or the shared instance an omitted one lands on. */
function normaliseSession(session: unknown): string {
	return typeof session === "string" && session.trim() ? session.trim() : "default";
}
