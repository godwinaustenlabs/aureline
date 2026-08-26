import { describe, expect, it } from "vitest";
import { error, json } from "./http";

describe("json", () => {
	it("serialises the body and declares JSON, so a browser parses it", async () => {
		const response = json({ ok: true });

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("application/json");
		expect(await response.json()).toEqual({ ok: true });
	});

	it("takes the status it is given", () => {
		expect(json({ ok: false }, 503).status).toBe(503);
	});

	it("returns 200 for a failed run, which is the point of the contract", async () => {
		// A run that failed is a successful HTTP exchange reporting a failed run.
		// 500 here would tell the caller the request broke, which it did not, and
		// would hide the `error` field explaining what actually happened.
		const response = json({ status: "failed", error: "image: flux down" });

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ status: "failed" });
	});
});

describe("error", () => {
	it("wraps the message in an error field at the given status", async () => {
		const response = error("design_session_id is required", 400);

		expect(response.status).toBe(400);
		expect(response.headers.get("Content-Type")).toBe("application/json");
		expect(await response.json()).toEqual({ error: "design_session_id is required" });
	});
});
