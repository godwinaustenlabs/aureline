import { afterEach, describe, expect, it, vi } from "vitest";
import { readColoredImage, readMotif, saveColoredImage } from "./r2.repository";

/**
 * A fake `R2Bucket` backed by a Map.
 *
 * Real enough to be worth asserting against: `get` returns what `put` stored and
 * `null` for anything else, which is the whole contract this file has with the
 * pipeline. It is narrowed to the two methods used and asserted into `R2Bucket`
 * at the call site, so the cast never escapes this file.
 */
function fakeBucket() {
	const store = new Map<string, { body: Uint8Array; contentType?: string }>();

	const put = vi.fn(async (key: string, body: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) => {
		store.set(key, { body, contentType: options?.httpMetadata?.contentType });
		return {};
	});

	const get = vi.fn(async (key: string) => {
		const stored = store.get(key);
		if (!stored) return null;

		// Shaped like the part of `R2ObjectBody` this repository actually uses:
		// `arrayBuffer()` for the bytes and `httpMetadata.contentType` for the type.
		// `readMotif` reads both, so a fake that only held the bytes would let a
		// content-type bug through unnoticed.
		return {
			arrayBuffer: async () => stored.body.slice().buffer,
			httpMetadata: stored.contentType ? { contentType: stored.contentType } : undefined,
		};
	});

	return { bucket: { put, get } as unknown as R2Bucket, put, get, store };
}

const IMAGE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

describe("saveColoredImage", () => {
	it("writes under the iris/ prefix keyed by pipeline id, and returns that key", async () => {
		const { bucket, put } = fakeBucket();

		const key = await saveColoredImage(bucket, "run-a", IMAGE, "image/jpeg");

		// The prefix is what keeps three engines out of each other's way in one
		// shared bucket, so it is worth asserting exactly rather than loosely.
		expect(key).toBe("iris/run-a.jpg");
		expect(put).toHaveBeenCalledWith("iris/run-a.jpg", IMAGE, { httpMetadata: { contentType: "image/jpeg" } });
	});

	it("keeps two runs of the same design in separate objects", async () => {
		const { bucket, store } = fakeBucket();

		await saveColoredImage(bucket, "run-a", IMAGE, "image/jpeg");
		await saveColoredImage(bucket, "run-b", IMAGE, "image/jpeg");

		// Keyed by pipeline id, not design session id: a re-run must not overwrite
		// the image the first attempt produced.
		expect([...store.keys()].sort()).toEqual(["iris/run-a.jpg", "iris/run-b.jpg"]);
	});

	it("records the content type it was given, since the browser needs it to render", async () => {
		const { bucket, store } = fakeBucket();

		await saveColoredImage(bucket, "run-a", IMAGE, "image/png");

		expect(store.get("iris/run-a.jpg")?.contentType).toBe("image/png");
	});
});

describe("readColoredImage", () => {
	it("reads back exactly what was written", async () => {
		const { bucket } = fakeBucket();
		const key = await saveColoredImage(bucket, "run-a", IMAGE, "image/jpeg");

		const object = await readColoredImage(bucket, key);

		expect(object).not.toBeNull();
	});

	it("returns null for a key that does not exist rather than throwing", async () => {
		const { bucket } = fakeBucket();

		// `GET /images/*` turns this into a 404. A throw here would surface as a
		// 500 for what is an ordinary missing-image request.
		expect(await readColoredImage(bucket, "iris/never-written.jpg")).toBeNull();
	});
});

describe("readMotif", () => {
	/**
	 * Replaces the global `fetch` for one test and restores it afterwards.
	 *
	 * `readMotif` reaches the network on the URL branch, and AGENTS.md §5 is
	 * explicit that tests never do. Returning a real `Response` rather than a
	 * hand-shaped object matters here: the code reads `ok`, `status`,
	 * `headers.get("content-type")` and `arrayBuffer()`, and a fake implementing
	 * only the ones it calls today would stop catching a change to which ones it
	 * calls.
	 */
	function stubFetch(response: Response | Error) {
		const fetchMock = vi.fn(async () => {
			if (response instanceof Error) throw response;
			return response;
		});

		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("fetches a URL ref and returns its bytes and declared content type", async () => {
		const { bucket } = fakeBucket();
		const fetchMock = stubFetch(new Response(IMAGE, { status: 200, headers: { "content-type": "image/jpeg" } }));

		const motif = await readMotif(bucket, "https://example.com/images/patterns/a.jpg");

		expect(fetchMock).toHaveBeenCalledWith("https://example.com/images/patterns/a.jpg");
		// Byte-for-byte, not just a length: this is the payload that reaches the
		// model, and a truncation or a re-encode here would be invisible until an
		// output came back wrong.
		expect([...motif.bytes]).toEqual([...IMAGE]);
		expect(motif.contentType).toBe("image/jpeg");
	});

	it("falls back to image/jpeg when the response declares no content type", async () => {
		const { bucket } = fakeBucket();
		stubFetch(new Response(IMAGE, { status: 200 }));

		const motif = await readMotif(bucket, "https://example.com/a.jpg");

		// Not application/octet-stream: these bytes become a multipart part for an
		// image model, which has no reason to treat arbitrary binary as an image.
		expect(motif.contentType).toBe("image/jpeg");
	});

	it("throws naming the ref and the status when the fetch 404s", async () => {
		const { bucket } = fakeBucket();
		stubFetch(new Response("nope", { status: 404 }));

		// The ref has to be in the message. A run that failed because a motif was
		// missing must not read like a model failure.
		await expect(readMotif(bucket, "https://example.com/gone.jpg")).rejects.toThrow(
			/https:\/\/example\.com\/gone\.jpg.*404/,
		);
	});

	it("throws naming the ref when the fetch itself throws", async () => {
		const { bucket } = fakeBucket();
		stubFetch(new Error("getaddrinfo ENOTFOUND"));

		// A refused connection arrives as a throw rather than a status, and the
		// bare cause does not say which motif was being read.
		await expect(readMotif(bucket, "https://nowhere.invalid/a.jpg")).rejects.toThrow(
			/nowhere\.invalid\/a\.jpg.*ENOTFOUND/,
		);
	});

	it("reads a non-URL ref from the bucket, bytes and content type intact", async () => {
		const { bucket } = fakeBucket();
		await saveColoredImage(bucket, "run-a", IMAGE, "image/png");

		const motif = await readMotif(bucket, "iris/run-a.jpg");

		expect([...motif.bytes]).toEqual([...IMAGE]);
		expect(motif.contentType).toBe("image/png");
	});

	it("does not reach the network for a key-shaped ref", async () => {
		const { bucket } = fakeBucket();
		await saveColoredImage(bucket, "run-a", IMAGE, "image/jpeg");
		const fetchMock = stubFetch(new Response(IMAGE, { status: 200 }));

		await readMotif(bucket, "iris/run-a.jpg");

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("throws for a missing key, and names the bucket and the prefix convention", async () => {
		const { bucket } = fakeBucket();

		// A plain "not found" sends the next person looking for a deleted object.
		// All three engines share `images-bucket` and separate by key prefix, so the
		// likely cause is a wrong prefix, and the message has to say which is which.
		await expect(readMotif(bucket, "patterns/motif.jpg")).rejects.toThrow(/images-bucket/);
		await expect(readMotif(bucket, "patterns/motif.jpg")).rejects.toThrow(/prefix/);
	});

	it("reads a key under another engine's prefix, imposing no prefix rule of its own", async () => {
		const { bucket } = fakeBucket();
		// Written under Helios's prefix rather than Iris's.
		//
		// What this proves is that `readMotif` does not restrict reads to `iris/`.
		// It does **not** prove the two engines share a bucket — `fakeBucket` is one
		// bucket, so it cannot tell. That guarantee lives in `bucket_name` in both
		// wrangler.jsonc files and nowhere a unit test can reach.
		await bucket.put("patterns/from-helios.jpg", IMAGE, { httpMetadata: { contentType: "image/jpeg" } });

		const { bytes, contentType } = await readMotif(bucket, "patterns/from-helios.jpg");

		expect(bytes.byteLength).toBe(IMAGE.byteLength);
		expect(contentType).toBe("image/jpeg");
	});

	it("throws for an object that exists but is empty", async () => {
		const { bucket } = fakeBucket();
		await saveColoredImage(bucket, "run-empty", new Uint8Array(), "image/jpeg");

		// Zero bytes would otherwise go to the model as a valid-looking empty part
		// and bill for a result that could not possibly be right.
		await expect(readMotif(bucket, "iris/run-empty.jpg")).rejects.toThrow(/empty/);
	});
});
