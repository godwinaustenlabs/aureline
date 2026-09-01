import { Agent } from "agents";
import { getDb } from "./db/client";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../drizzle/migrations";
import { HeliosRequestSchema, HeliosResumeRequestSchema } from "@aureline/shared-types";
import { runPipeline } from "./services/pipeline";
import { resumeRun } from "./services/resume";
import { getRunRows, listRuns } from "./repository/do.repository";
import { firstIssueMessage } from "./utils";
import { json, error, readRequestBody } from "./http";

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
		const url = new URL(request.url);
		const db = getDb(this.ctx.storage);

		// Ahead of the POST check and the body parse: this is the one route with
		// no body to read, and 405-ing it would make the history unreachable.
		//
		// Read-only and free. It must never be able to reach a model: it is the
		// route a page is allowed to call on load and on every refresh.
		if (request.method === "GET" && url.pathname === "/runs") {
			const pipelineId = url.searchParams.get("pipeline_id")?.trim();
			// Rows exactly as stored, not reshaped. Whatever reads this is
			// debugging, and the stored shape is the thing worth seeing.
			return json({ runs: pipelineId ? await getRunRows(db, pipelineId) : await listRuns(db) });
		}

		if (request.method !== "POST") {
			return error("POST required", 405);
		}

		// JSON or multipart, flattened to one shape. `/resume` reads it too: it has
		// no image field, but a caller posting a form to it should get the schema's
		// own 400 rather than an unreadable-body one.
		const body = await readRequestBody(request);

		if (url.pathname === "/resume") {
			const parsed = HeliosResumeRequestSchema.safeParse(body);
			if (!parsed.success) {
				return error(firstIssueMessage(parsed.error), 400);
			}

			const outcome = await resumeRun(db, parsed.data.pipeline_id, this.env, url.origin);
			// A refusal never became an invocation: no rows, no model call, nothing
			// billed. 409 rather than a `failed` result, which would claim a run
			// happened. A run that did happen and failed still comes back as a 200.
			return outcome.ok ? json(outcome.result) : error(outcome.reason, 409);
		}

		const parsed = HeliosRequestSchema.safeParse(body);
		if (!parsed.success) {
			// A malformed request never became a pipeline invocation, so there is no
			// pipeline_id to report — this is a transport error, not a run outcome.
			return error(firstIssueMessage(parsed.error), 400);
		}

		const result = await runPipeline(db, parsed.data, this.env, url.origin);
		return json(result);
	}
}
