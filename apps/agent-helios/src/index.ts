import { DurableObject } from "cloudflare:workers";
import { Agent, routeAgentRequest } from "agents";
import { HeliosResult } from "@aureline/shared-types";

export class HeliosAgent extends Agent<Env> {
	async onRequest(request: Request) {
		// textual-planner + image-model orchestration will live here
		const result: HeliosResult = {
			requestId: "example-request-id",
			imageUrl: "https://example.com/generated-image.png",
			params: {
				color: "vibrant",
				contrast: "high",
				tone: "warm",
				style: "realistic",
				composition: "centered"
			},
			modelVersion: "1.0.0",
			cost: 0.05
		};
		return new Response(JSON.stringify(result), {
			headers: {
				"Content-Type": "application/json"
			}
		});
	}
}

export default {
	/**
	 * This is the standard fetch handler for a Cloudflare Worker
	 *
	 * @param request - The request submitted to the Worker from the client
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 * @param ctx - The execution context of the Worker
	 * @returns The response to be sent back to the client
	 */
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname === "/") {
			return new Response("Helios Agent is running", { status: 200 });
		}
		return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
	},
};
