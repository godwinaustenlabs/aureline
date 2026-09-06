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

/** The form field a reference image arrives under. Shared by the reader below
 *  and by `scopeKey` in `index.ts`, which reads the same body a step earlier. */
export const IMAGE_FIELD = "image";

/**
 * True when this request carries a `multipart/form-data` body.
 *
 * A prefix match, not equality: the header always carries a `; boundary=...`
 * parameter, so `=== "multipart/form-data"` never matches a real browser
 * request. Case-insensitive because the header name's value is not required to
 * be lowercase and browsers are not consistent about it.
 */
export function isMultipart(request: Request): boolean {
	const contentType = request.headers.get("content-type") ?? "";
	return contentType.toLowerCase().trimStart().startsWith("multipart/form-data");
}

/**
 * The request body as a plain object, whichever way it was sent.
 *
 * Two transports reach the same schema. A JSON request takes exactly the path
 * it always did — `request.json()`, and `undefined` when that fails — so
 * nothing about an existing caller changes. A multipart request is read with
 * `request.formData()` and flattened into the same shape, with the `image`
 * field converted from a `File` to `{ bytes, contentType }` before validation:
 * by the time this returns, nothing downstream can tell which transport was
 * used, and nothing downstream should be able to.
 *
 * **Returns `undefined` rather than throwing on an unreadable body.** The
 * caller answers a malformed request with a 400 from the schema's own error,
 * and that is a better message than anything this function could invent.
 */
export async function readRequestBody(request: Request): Promise<unknown> {
	if (!isMultipart(request)) {
		console.log("request: json, no image");
		return request.json().catch(() => undefined);
	}

	const form = await request.formData().catch(() => undefined);
	if (form === undefined) {
		console.warn("request: multipart body could not be read");
		return undefined;
	}

	const body: Record<string, unknown> = {};

	for (const [key, value] of form.entries()) {
		if (key === IMAGE_FIELD) continue;
		// Every non-image field is a text field. A `File` under any other name is
		// not something this contract has a meaning for, so it is left out and
		// the schema reports the field as missing rather than as the wrong type.
		if (typeof value === "string") body[key] = value;
	}

	const image = await readImageField(form);
	if (image !== undefined) body[IMAGE_FIELD] = image;

	// The one line that says whether the upload survived the transport. A file
	// picked in the browser but reported here as "no image" means the failure is
	// upstream of the pipeline, which is otherwise indistinguishable from a
	// planner that simply ignored the picture.
	console.log(`request: multipart, ${image === undefined ? "no image" : describeImage(image)}`);

	return body;
}

/** Size and type of an attached image. Never its bytes. */
function describeImage(image: { bytes: Uint8Array; contentType: string }): string {
	return `image ${(image.bytes.length / 1024).toFixed(1)}KB ${image.contentType}`;
}

/**
 * The uploaded reference image, or `undefined` when none was attached.
 *
 * **The zero-byte case is handled explicitly and is not an edge case.** A file
 * input that the user never picked a file for still serializes into the form,
 * as a `File` with an empty name and zero length. Treating that as an image
 * would send a planner an empty `data:` URL — a full-price call that fails for
 * a reason the error would not name. It means "no image", and is read that way.
 *
 * There is deliberately no size limit. The consequence is recorded in the
 * phase-1 plan's accepted risks: a large upload fails at or after the model
 * call rather than here, with an error that says nothing about size.
 */
async function readImageField(
	form: FormData,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string } | undefined> {
	const value = form.get(IMAGE_FIELD);

	if (value === null || typeof value === "string") return undefined;
	if (value.size === 0) return undefined;

	return {
		bytes: new Uint8Array(await value.arrayBuffer()),
		// The browser fills this in from the file itself. Falling back rather than
		// throwing: an octet-stream that the model rejects is a clearer failure
		// than a 400 on a file the user really did attach.
		contentType: value.type || "application/octet-stream",
	};
}

/**
 * The `session_id` off a request body, without consuming it.
 *
 * Its own function because `index.ts` needs it *before* routing — the session
 * picks which Durable Object serves the request (ADR-0005) — and the DO then
 * reads the same body again for real.
 *
 * **The multipart branch is load-bearing.** Reading a multipart body with
 * `.json()` throws, and the surrounding `.catch()` turns that into "no session",
 * which routes every uploaded request to the shared instance literally named
 * `default`. That is a silent mis-route: no error, no log, and a history that
 * looks empty for every named session that ever attached an image.
 */
export async function readSessionId(request: Request): Promise<unknown> {
	const clone = request.clone();

	if (isMultipart(clone)) {
		const form = await clone.formData().catch(() => undefined);
		return form?.get("session_id") ?? undefined;
	}

	const body = await clone.json<{ session_id?: unknown }>().catch(() => undefined);
	return body?.session_id;
}
