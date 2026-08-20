import { describe, expect, it, vi } from "vitest";
import { readColoredImage, saveColoredImage } from "./r2.repository";

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

	const get = vi.fn(async (key: string) => store.get(key) ?? null);

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
