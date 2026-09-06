import {
	MIN_PROMPT_LENGTH,
	isEngineName,
	isSlotOf,
	listPrompts,
	savePrompt,
	type EngineName,
} from "./prompts";

/**
 * The playground's server side.
 *
 * It exists for exactly one job: the prompt editor reads and writes each
 * engine's `prompts` table through a D1 binding, and a browser cannot hold one.
 * Every other call the page makes still goes straight to the engine workers
 * cross-origin.
 *
 * Two rules hold here:
 *
 * 1. **This worker never calls a model and never spends anything.** Every route
 *    below is a D1 read or a D1 write. If that stops being true, it stops being
 *    safe to call from an effect.
 * 2. **It only ever touches `prompts`.** The run history belongs to the engines
 *    and is read through their own `GET /runs`, which is what keeps this from
 *    becoming a second, competing view of engine state.
 *
 * There is no CORS handling and there should not be: the page is served from
 * this same worker, so `/api/prompts` is same-origin. A cross-origin caller is
 * not a case worth supporting here.
 *
 * **No authentication.** Anyone who can reach this path can rewrite the system
 * prompt of a worker that spends real money per call, and CORS does not prevent
 * it — this is not a browser-only surface. The team rule is that only Saad edits
 * prompts; nothing here enforces it. Cloudflare Access in front of `/api/*` is
 * the fix and it needs no code.
 */

/** Slots the engine reads, plus what is stored for each. */
interface PromptsResponse {
	engine: EngineName;
	prompts: Awaited<ReturnType<typeof listPrompts>>;
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			// A prompt edited a second ago must not be served from a cache.
			"cache-control": "no-store",
		},
	});

const fail = (status: number, message: string): Response => json({ error: message }, status);

/** The engine's database, chosen by name rather than by indexing `env`. */
function databaseFor(env: Env, engine: EngineName): D1Database {
	return engine === "iris" ? env.IRIS_DB : env.HELIOS_DB;
}

async function handlePrompts(request: Request, env: Env): Promise<Response> {
	if (request.method === "GET") {
		const engine = new URL(request.url).searchParams.get("engine");
		if (!isEngineName(engine)) {
			return fail(400, `engine must be "iris" or "helios", not ${JSON.stringify(engine)}`);
		}

		return json({ engine, prompts: await listPrompts(databaseFor(env, engine), engine) } satisfies PromptsResponse);
	}

	if (request.method === "PUT") {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return fail(400, "body must be JSON");
		}

		const { engine, slot, prompt_text: promptText } = (body ?? {}) as {
			engine?: unknown;
			slot?: unknown;
			prompt_text?: unknown;
		};

		if (!isEngineName(engine)) {
			return fail(400, `engine must be "iris" or "helios", not ${JSON.stringify(engine)}`);
		}
		// The whitelist, not a formality: an unrecognised slot would write a row no
		// engine ever reads, which looks exactly like a save that did nothing.
		if (!isSlotOf(engine, slot)) {
			return fail(400, `${JSON.stringify(slot)} is not a slot of ${engine}`);
		}
		if (typeof promptText !== "string") {
			return fail(400, "prompt_text must be a string");
		}
		// Refused here rather than saved and then ignored by the engine, which is
		// what would happen otherwise — a save that appears to work and changes
		// nothing at all.
		if (promptText.trim().length < MIN_PROMPT_LENGTH) {
			return fail(422, `a prompt must be at least ${MIN_PROMPT_LENGTH} characters`);
		}

		const updatedAt = await savePrompt(databaseFor(env, engine), slot as string, promptText);
		return json({ engine, slot, updated_at: updatedAt });
	}

	return fail(405, `${request.method} is not allowed on /api/prompts`);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (pathname === "/api/prompts") {
			try {
				return await handlePrompts(request, env);
			} catch (cause) {
				// The page has to be able to tell "the database refused this" from
				// "the request was wrong", so this never degrades to a 400.
				console.error("prompts route failed:", cause);
				return fail(500, cause instanceof Error ? cause.message : "unknown error");
			}
		}

		// `run_worker_first` routes only `/api/*` here, so in practice this is
		// unreachable. It stays because a change to that list should fall back to
		// serving the page rather than 404ing it.
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
