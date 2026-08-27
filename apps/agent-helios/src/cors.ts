/**
 * Cross-origin access for the playground (ticket 09).
 *
 * The playground is its own app on its own host, so every call it makes is a
 * cross-origin one and the browser blocks all of them unless this worker says
 * otherwise. A plain `<img src>` is the single exception and needs nothing from
 * here; anything reached through `fetch` needs these headers.
 *
 * **An allow-list, never `*`.** `/generate` has no auth and spends real money on
 * every call, so the origin list is the only thing standing between us and any
 * webpage on the internet being able to bill our account. The list lives in
 * `wrangler.jsonc` vars, where it is reviewed, rather than in KV where a typo
 * would silently open or close the door.
 *
 * **No credentials.** Nothing here authenticates, so the playground must not
 * send cookies and this never answers `Access-Control-Allow-Credentials`. That
 * also keeps the allow-list check the only thing that matters: with credentials
 * in play, browsers additionally forbid `*`, and we would be one config edit
 * away from a rule that fails in a confusing way rather than an obvious one.
 */

/** The methods this worker actually serves. */
const ALLOWED_METHODS = "GET, POST, OPTIONS";

/**
 * Request headers a caller may set. `Content-Type` covers the JSON posts; every
 * other header the playground sends is one browsers allow without asking.
 */
const ALLOWED_HEADERS = "Content-Type";

/** How long a browser may reuse one preflight answer. 24 hours, its usual cap. */
const MAX_AGE_SECONDS = "86400";

/**
 * The configured origins, as an exact-match list.
 *
 * Trailing slashes are trimmed because people write them in config and browsers
 * never send them, which otherwise produces an allow-list that looks right and
 * matches nothing.
 */
export function parseAllowedOrigins(configured: string | undefined): string[] {
	return (configured ?? "")
		.split(",")
		.map((origin) => origin.trim().replace(/\/+$/, ""))
		.filter(Boolean);
}

/**
 * The single var this file reads. Structural rather than `Pick<Env,
 * "ALLOWED_ORIGINS">` because `wrangler types` generates that var as a literal
 * type — the exact origin list currently in `wrangler.jsonc` — so a `Pick` could
 * only ever be satisfied by that one string, and every test would need a cast to
 * build one. The real `Env` satisfies this, since its literal is a `string`.
 */
export type CorsEnv = { ALLOWED_ORIGINS?: string };

/**
 * The CORS headers belonging on a response to this request.
 *
 * `Vary: Origin` rides on every answer, including the ones carrying no
 * permission at all. The reply differs by origin, and a cache that missed that
 * would hand one origin's approval to another.
 */
export function corsHeaders(request: Request, env: CorsEnv): Record<string, string> {
	const headers: Record<string, string> = { Vary: "Origin" };

	const origin = request.headers.get("Origin");
	if (origin && parseAllowedOrigins(env.ALLOWED_ORIGINS).includes(origin)) {
		headers["Access-Control-Allow-Origin"] = origin;
		headers["Access-Control-Allow-Methods"] = ALLOWED_METHODS;
		headers["Access-Control-Allow-Headers"] = ALLOWED_HEADERS;
	}

	return headers;
}

/**
 * Answers a preflight `OPTIONS`.
 *
 * A refused origin gets a 403 naming the reason rather than a silent 204. The
 * browser blocks the call either way and JavaScript cannot read either body,
 * but the developer staring at the network tab can, and "origin not allowed" is
 * a much shorter afternoon than a bare CORS failure.
 */
export function preflight(request: Request, env: CorsEnv): Response {
	const headers = corsHeaders(request, env);

	if (!headers["Access-Control-Allow-Origin"]) {
		return new Response(`origin not in ALLOWED_ORIGINS: ${request.headers.get("Origin") ?? "(none sent)"}`, {
			status: 403,
			headers,
		});
	}

	return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Max-Age": MAX_AGE_SECONDS } });
}

/**
 * Copies the CORS headers onto a response the worker already built.
 *
 * Rebuilds it rather than mutating: a response that came back from the Durable
 * Object or from R2 has immutable headers, and setting one throws.
 *
 * A WebSocket upgrade is handed back untouched. Its 101 cannot be reconstructed,
 * and the handshake is not something CORS governs anyway.
 */
export function withCors(response: Response, request: Request, env: CorsEnv): Response {
	if (response.status === 101 || response.webSocket) {
		return response;
	}

	const withHeaders = new Response(response.body, response);
	for (const [name, value] of Object.entries(corsHeaders(request, env))) {
		withHeaders.headers.set(name, value);
	}

	return withHeaders;
}
