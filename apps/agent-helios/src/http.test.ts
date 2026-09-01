import { describe, expect, it } from "vitest";
import { error, json, readRequestBody, readSessionId } from "./http";

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

/**
 * The two transports, and the promise that adding one changed nothing about
 * the other.
 *
 * A `Request` built with a `FormData` body sets its own multipart content-type
 * with a real boundary, exactly as a browser does — which is the thing worth
 * exercising, since a hand-written `multipart/form-data` header with no
 * boundary is precisely the bug this code has to survive.
 */
describe("readRequestBody", () => {
	it("reads a JSON body exactly as it always did", async () => {
		const request = new Request("https://example.com/generate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ concept: "navy paisley", design_session_id: "d-1" }),
		});

		expect(await readRequestBody(request)).toEqual({
			concept: "navy paisley",
			design_session_id: "d-1",
		});
	});

	it("returns undefined for a malformed JSON body, rather than throwing", async () => {
		// The caller turns this into the schema's own 400. A throw here would
		// escape as an opaque 500 instead.
		const request = new Request("https://example.com/generate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{ not json",
		});

		expect(await readRequestBody(request)).toBeUndefined();
	});

	it("flattens a multipart body into the same shape a JSON body produces", async () => {
		const form = new FormData();
		form.set("concept", "navy paisley");
		form.set("design_session_id", "d-1");

		const request = new Request("https://example.com/generate", { method: "POST", body: form });

		// No `image` key at all, rather than one set to undefined: the schema's
		// field is optional, and an explicit undefined is a different thing.
		expect(await readRequestBody(request)).toEqual({
			concept: "navy paisley",
			design_session_id: "d-1",
		});
	});

	it("converts an uploaded image to bytes and its content type", async () => {
		const form = new FormData();
		form.set("concept", "navy paisley");
		form.set("image", new File([new Uint8Array([137, 80, 78, 71])], "ref.png", { type: "image/png" }));

		const body = (await readRequestBody(request(form))) as {
			image: { bytes: Uint8Array; contentType: string };
		};

		expect(Array.from(body.image.bytes)).toEqual([137, 80, 78, 71]);
		expect(body.image.contentType).toBe("image/png");
	});

	it("treats a zero-byte file as no image at all", async () => {
		// Not an edge case: a file input the user never picked a file for still
		// serializes into the form, as an empty `File`. Reading it as an image
		// sends the planner an empty data URL — a full-price call that fails for
		// a reason the error would not name.
		const form = new FormData();
		form.set("concept", "navy paisley");
		form.set("image", new File([], "", { type: "application/octet-stream" }));

		expect(await readRequestBody(request(form))).not.toHaveProperty("image");
	});

	it("falls back to octet-stream when the browser sent no content type", async () => {
		const form = new FormData();
		form.set("image", new File([new Uint8Array([1, 2])], "ref"));

		const body = (await readRequestBody(request(form))) as { image: { contentType: string } };

		expect(body.image.contentType).toBe("application/octet-stream");
	});
});

describe("readSessionId", () => {
	it("reads session_id off a JSON body", async () => {
		const req = new Request("https://example.com/generate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ session_id: "studio-a" }),
		});

		expect(await readSessionId(req)).toBe("studio-a");
	});

	it("reads session_id off a multipart body", async () => {
		// The load-bearing one. Reading a multipart body with `.json()` throws,
		// the throw is swallowed, and the request routes to the Durable Object
		// literally named `default` — a silent mis-route that shows up much later
		// as a session whose history is inexplicably empty (ADR-0005).
		const form = new FormData();
		form.set("session_id", "studio-a");
		form.set("image", new File([new Uint8Array([1])], "ref.png", { type: "image/png" }));

		expect(await readSessionId(request(form))).toBe("studio-a");
	});

	it("leaves the body readable for the next reader", async () => {
		// It reads a clone, because the Durable Object reads the same body again
		// for real. Consuming it here would leave the agent with nothing.
		const form = new FormData();
		form.set("session_id", "studio-a");
		form.set("concept", "navy paisley");
		const req = request(form);

		await readSessionId(req);

		expect(await readRequestBody(req)).toMatchObject({ concept: "navy paisley" });
	});

	it("is undefined when the body names no session", async () => {
		expect(await readSessionId(request(new FormData()))).toBeUndefined();
	});
});

/** A POST whose body is this form, with the boundary the platform generates. */
function request(form: FormData): Request {
	return new Request("https://example.com/generate", { method: "POST", body: form });
}
