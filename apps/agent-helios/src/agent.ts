import { Agent } from "agents";
import { getDb } from "./db/client";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../drizzle/migrations";
import { HeliosRequestSchema, HeliosResumeRequestSchema } from "@aureline/shared-types";
import { runPipeline } from "./services/pipeline";
import { resumeRun } from "./services/resume";
import { firstIssueMessage } from "./utils";

/**
 * Helios — the Pattern Engine.
 *
 * Acts as its own inline controller: request validation happens directly in
 * `onRequest`, with no intermediate controller layer. One instance is scoped to
 * a session/project, not to a single pipeline invocation (ADR-0005).
 */
export class HeliosAgent extends Agent<Env> {
	/** Applies pending Drizzle migrations against this instance's own DO-local
	 * SQLite storage. Runs once per Durable Object wake-up (safe to call on
	 * every onStart — drizzle tracks what's already applied). */
	async onStart() {
		await migrate(getDb(this.ctx.storage), migrations);
	}

	async onRequest(request: Request) {
		if (request.method !== "POST") {
			return error("POST required", 405);
		}

		const url = new URL(request.url);
		const body = await request.json().catch(() => undefined);
		const db = getDb(this.ctx.storage);

		if (url.pathname === "/resume") {
			const parsed = HeliosResumeRequestSchema.safeParse(body);
			if (!parsed.success) {
				return error(firstIssueMessage(parsed.error), 400);
			}

			const outcome = await resumeRun(db, parsed.data.p_invoc_id, this.env, url.origin);
			// A refusal never became an invocation: no rows, no model call, nothing
			// billed. 409 rather than a `failed` result, which would claim a run
			// happened. A run that did happen and failed still comes back as a 200.
			return outcome.ok ? json(outcome.result) : error(outcome.reason, 409);
		}

		const parsed = HeliosRequestSchema.safeParse(body);
		if (!parsed.success) {
			// A malformed request never became a pipeline invocation, so there is no
			// p_invoc_id to report — this is a transport error, not a run outcome.
			return error(firstIssueMessage(parsed.error), 400);
		}

		const result = await runPipeline(db, parsed.data, this.env, url.origin);
		return json(result);
	}
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