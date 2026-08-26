import { Agent } from "agents";
import { getDb } from "./db/client";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../drizzle/migrations";
import { AtlasRequestSchema, AtlasResumeRequestSchema } from "@aureline/shared-types";
import { runPipeline } from "./services/pipeline";
import { getRun, listRuns } from "./repository/do.repository";
import { firstIssueMessage } from "./utils";

/**
 * Atlas — the Repeat Engine.
 *
 * Acts as its own inline controller: request validation happens directly in
 * `onRequest`, with no intermediate controller layer. One instance is scoped to
 * a session/project, not to a single pipeline invocation (ADR-0005).
 */
export class AtlasAgent extends Agent<Env> {
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
		// Read-only and free, permanently. It must never be able to reach a model:
		// it is the route a page is allowed to call on load and on every refresh.
		// If it ever gains a side effect, that is a bug.
		if (request.method === "GET" && url.pathname === "/runs") {
			const pipelineId = url.searchParams.get("pipeline_id")?.trim();

			// An envelope, not a bare array, matching Helios and Iris.
			//
			// Rows exactly as stored, not reshaped. Whatever reads this is
			// debugging, and the stored shape is the thing worth seeing. Atlas has
			// ONE row per invocation where the other two engines have two, so
			// anything consuming this must not assume a pair (ADR-ATLAS-0001).
			if (pipelineId) {
				const run = await getRun(db, pipelineId);
				return json({ runs: run ? [run] : [] });
			}

			return json({ runs: await listRuns(db) });
		}

		if (request.method !== "POST") {
			return error("POST required", 405);
		}

		const body = await request.json().catch(() => undefined);

		if (url.pathname === "/resume") {
			const parsed = AtlasResumeRequestSchema.safeParse(body);
			if (!parsed.success) {
				return error(firstIssueMessage(parsed.error), 400);
			}

			// The route exists and validates; its behaviour does not (atlas-06).
			// atlas-08 builds it: it re-enters `runImageStage` with the placement
			// read back off the row, under a spend cap counted over the root brief.
			// 501 rather than a failed AtlasResult, because nothing ran — returning
			// a settled result would claim an invocation happened.
			return error("resume is not implemented yet — see atlas-08", 501);
		}

		const parsed = AtlasRequestSchema.safeParse(body);
		if (!parsed.success) {
			// A malformed request never became a pipeline invocation, so there is no
			// pipeline_id to report — this is a transport error, not a run outcome.
			return error(firstIssueMessage(parsed.error), 400);
		}

		// A failed run comes back from here as a 200 carrying `status: "failed"`.
		// Not a 4xx and not a 5xx: the HTTP request succeeded even though the run
		// did not. That is what lets one playground handle all three engines with
		// no per-engine special case.
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
