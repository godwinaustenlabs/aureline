/**
 * Tiny JSON response helpers shared by the worker's HTTP layer.
 *
 * Kept apart from `agent.ts` so they can be imported without pulling in the
 * `agents` package (which resolves Workers-only `cloudflare:` modules) — that
 * is what lets `pipeline.test.ts` build the exact `Response` `/generate`
 * returns and assert on its status, under plain Node/Vitest.
 */

export function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export function error(message: string, status: number) {
	return json({ error: message }, status);
}
