import { Agent } from "agents";
import { IrisRequestSchema, IrisResumeRequestSchema } from "@aureline/shared-types";
import { describeConfig, resolveConfig } from "./config";
import { firstIssueMessage } from "./utils";

/**
 * Iris — the Color Engine.
 *
 * Acts as its own inline controller: request validation happens directly in
 * `onRequest`, with no intermediate controller layer. One instance is scoped to
 * a session/project, not to a single pipeline invocation (ADR-0005).
 *
 * Scaffolding only. Every route below validates its input and then stops:
 * iris-05 supplies the pipeline the three of them call into.
 */
export class IrisAgent extends Agent<Env> {
	/**
	 * Applies pending Drizzle migrations against this instance's own DO-local
	 * SQLite storage, once per Durable Object wake-up.
	 *
	 * Empty until iris-03, which is the ticket that writes `db/schema.ts`,
	 * `db/client.ts` and generates `../drizzle/migrations`. None of those exist
	 * yet, so there is nothing to migrate and the real call cannot compile.
	 * iris-03 replaces this body with:
	 *
	 *     await migrate(getDb(this.ctx.storage), migrations);
	 *
	 * Calling it on every wake-up is safe — drizzle tracks what is already
	 * applied.
	 */
	async onStart() {
		// iris-03.
	}

	async onRequest(request: Request) {
		const url = new URL(request.url);

		// Ahead of the POST check and the body parse: this is the one route with
		// no body to read, and 405-ing it would make the history unreachable.
		//
		// Read-only and free. It must never be able to reach a model: it is the
		// route a page is allowed to call on load and on every refresh.
		if (request.method === "GET" && url.pathname === "/runs") {
			// iris-03 supplies getRunRows/listRuns; iris-05 returns { runs: [...] }.
			return notImplemented("GET /runs");
		}

		if (request.method !== "POST") {
			return error("POST required", 405);
		}

		const body = await request.json().catch(() => undefined);

		if (url.pathname === "/resume") {
			const parsed = IrisResumeRequestSchema.safeParse(body);
			if (!parsed.success) {
				return error(firstIssueMessage(parsed.error), 400);
			}

			await logConfig(this.env);
			return notImplemented("POST /resume");
		}

		const parsed = IrisRequestSchema.safeParse(body);
		if (!parsed.success) {
			// A malformed request never became a pipeline invocation, so there is no
			// p_invoc_id to report — this is a transport error, not a run outcome.
			return error(firstIssueMessage(parsed.error), 400);
		}

		await logConfig(this.env);
		return notImplemented("POST /generate");
	}
}

/**
 * Resolves the runtime config and logs where each value came from.
 *
 * Called on the two routes that will actually spend money, once per request and
 * never at wake-up or module scope (ADR-0008): two reads straddling a KV edit
 * would produce one invocation that is half old model and half new.
 *
 * This exists so the KV path is exercised from the very first request rather
 * than staying unproven until iris-05. When iris-05 writes `runPipeline`, the
 * `resolveConfig` call moves there — outside the try block, because it never
 * throws — and this helper goes away. Do not leave both.
 */
async function logConfig(env: Env): Promise<void> {
	console.log(describeConfig(await resolveConfig(env)));
}

/**
 * A stub route, marked loudly enough that nobody mistakes it for a real 501.
 * Validation above it is already real, so a 501 here means the request was
 * well-formed and only the work is missing.
 */
function notImplemented(route: string): Response {
	return error(`not implemented: ${route} lands in iris-05`, 501);
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function error(message: string, status: number) {
	return json({ error: message }, status);
}
