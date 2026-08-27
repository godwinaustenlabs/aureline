import { describe, expect, it } from "vitest";
import { corsHeaders, parseAllowedOrigins, preflight, withCors, type CorsEnv } from "./cors";

const ALLOWED = "http://localhost:5173";

/**
 * An `env` carrying only the var CORS reads.
 *
 * No cast: `corsHeaders` and friends take `CorsEnv`, which is exactly this one
 * optional var. The cast that used to be here was hiding the fact that the
 * signature asked for a whole Workers `Env` it never touched (AGENTS.md §4).
 */
function fakeEnv(allowedOrigins: string | undefined = ALLOWED): CorsEnv {
	return { ALLOWED_ORIGINS: allowedOrigins };
}

/** A request from a browser page on `origin`, or from something that sent none. */
function request(origin?: string, method = "GET") {
	return new Request("https://helios.example/generate", {
		method,
		...(origin ? { headers: { Origin: origin } } : {}),
	});
}

describe("parseAllowedOrigins", () => {
	it("splits the list and trims the spaces people leave around commas", () => {
		expect(parseAllowedOrigins("http://a.test, http://b.test")).toEqual(["http://a.test", "http://b.test"]);
	});

	/**
	 * Config gets written with a trailing slash and browsers never send one, so
	 * without this the allow-list looks correct and matches nothing.
	 */
	it("drops a trailing slash so a configured origin still matches", () => {
		expect(parseAllowedOrigins("http://a.test/")).toEqual(["http://a.test"]);
	});

	it("treats an unset or empty var as allowing nobody", () => {
		expect(parseAllowedOrigins(undefined)).toEqual([]);
		expect(parseAllowedOrigins("  ")).toEqual([]);
	});
});

describe("corsHeaders", () => {
	it("grants the requesting origin when it is on the list", () => {
		const headers = corsHeaders(request(ALLOWED), fakeEnv());

		expect(headers["Access-Control-Allow-Origin"]).toBe(ALLOWED);
		expect(headers["Access-Control-Allow-Methods"]).toBe("GET, POST, OPTIONS");
	});

	it("grants nothing to an origin that is not on the list", () => {
		expect(corsHeaders(request("https://evil.test"), fakeEnv())["Access-Control-Allow-Origin"]).toBeUndefined();
	});

	/**
	 * Echoing the request's own origin is the whole mechanism, so a bug that
	 * echoed it before checking the list would look identical on the happy path
	 * and allow everyone. This pins the check rather than the echo.
	 */
	it("never answers with an origin other than the one that asked", () => {
		const headers = corsHeaders(request("https://evil.test"), fakeEnv("https://evil.test.attacker.test"));

		expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
	});

	/** The reply differs by origin, so a cache must not reuse one for another. */
	it("varies on Origin whether or not it granted anything", () => {
		expect(corsHeaders(request(ALLOWED), fakeEnv()).Vary).toBe("Origin");
		expect(corsHeaders(request("https://evil.test"), fakeEnv()).Vary).toBe("Origin");
	});

	/**
	 * Nothing here authenticates and the playground is told not to send cookies.
	 * Answering this header would invite a config where it does.
	 */
	it("never allows credentials", () => {
		expect(corsHeaders(request(ALLOWED), fakeEnv())["Access-Control-Allow-Credentials"]).toBeUndefined();
	});
});

describe("preflight", () => {
	it("answers an allowed origin with 204 and a cacheable permission", () => {
		const response = preflight(request(ALLOWED, "OPTIONS"), fakeEnv());

		expect(response.status).toBe(204);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
		expect(response.headers.get("Access-Control-Max-Age")).toBe("86400");
	});

	/**
	 * JavaScript cannot read this body, but the person in the network tab can,
	 * and a named refusal is a much shorter afternoon than a bare CORS failure.
	 */
	it("refuses an unlisted origin with 403 and says why", async () => {
		const response = preflight(request("https://evil.test", "OPTIONS"), fakeEnv());

		expect(response.status).toBe(403);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
		expect(await response.text()).toContain("https://evil.test");
	});
});

describe("withCors", () => {
	it("adds the headers without disturbing the response it was given", async () => {
		const original = new Response(JSON.stringify({ status: "completed" }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});

		const wrapped = withCors(original, request(ALLOWED), fakeEnv());

		expect(wrapped.status).toBe(200);
		expect(wrapped.headers.get("Content-Type")).toBe("application/json");
		expect(wrapped.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
		expect(await wrapped.json()).toEqual({ status: "completed" });
	});

	/**
	 * A response handed back by the Durable Object or by R2 has immutable
	 * headers, and setting one on it throws. This is that case.
	 */
	it("copes with a response whose headers cannot be mutated", () => {
		const immutable = Response.redirect("https://helios.example/", 302);

		expect(() => withCors(immutable, request(ALLOWED), fakeEnv())).not.toThrow();
	});

	it("carries a failure status through untouched", () => {
		const wrapped = withCors(new Response("Not found", { status: 404 }), request(ALLOWED), fakeEnv());

		expect(wrapped.status).toBe(404);
		expect(wrapped.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
	});

	it("leaves a response alone when the origin is not allowed", () => {
		const wrapped = withCors(new Response("ok"), request("https://evil.test"), fakeEnv());

		expect(wrapped.headers.get("Access-Control-Allow-Origin")).toBeNull();
		expect(wrapped.headers.get("Vary")).toBe("Origin");
	});

	/** Its 101 cannot be reconstructed, and CORS does not govern the handshake. */
	it("hands a websocket upgrade back as it is", () => {
		const upgrade = { status: 101, webSocket: {} } as unknown as Response;

		expect(withCors(upgrade, request(ALLOWED), fakeEnv())).toBe(upgrade);
	});
});
