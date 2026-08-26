import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IrisResultSchema, atlasInputFromIrisResult, AtlasRequestSchema } from "@aureline/shared-types";
import { SAMPLE_IRIS_RESULT, SAMPLE_FAILED_IRIS_RESULT } from "./sample-iris-result";
import {
	SAMPLE_GARMENT_OUTPUT_BASE64,
	SAMPLE_GARMENT_REFERENCE_BASE64,
	SAMPLE_IMAGE_HEIGHT,
	SAMPLE_IMAGE_WIDTH,
	decodeFixture,
} from "./sample-images";

describe("the Iris fixture is a real IrisResult", () => {
	it("passes IrisResultSchema.parse, not merely a type annotation", () => {
		// atlas-06 decision 9. A type annotation is checked at compile time
		// against a schema that may since have moved; this parse is what proves
		// the shape is still right. It is also what makes shared-02 cheap: if
		// this holds, swapping the fixture for Iris's live output is a data
		// change rather than a code change.
		expect(() => IrisResultSchema.parse(SAMPLE_IRIS_RESULT)).not.toThrow();
	});

	it("passes for the failed variant too", () => {
		expect(() => IrisResultSchema.parse(SAMPLE_FAILED_IRIS_RESULT)).not.toThrow();
	});

	it("feeds a valid AtlasRequest through atlasInputFromIrisResult", () => {
		const input = atlasInputFromIrisResult(SAMPLE_IRIS_RESULT);

		const request = AtlasRequestSchema.parse({
			...input,
			garment_ref: "https://example.com/shirt.jpg",
			garment_type: "tshirt",
			regions: ["back", "hem"],
		});

		expect(request.pattern_ref).toBe(SAMPLE_IRIS_RESULT.image_url);
		expect(request.design_session_id).toBe(SAMPLE_IRIS_RESULT.design_session_id);
	});

	it("refuses to build a request from a failed Iris run", () => {
		// A run with no image_url produced no pattern. Building a request from it
		// would reach a billed call with a reference to nothing.
		expect(() => atlasInputFromIrisResult(SAMPLE_FAILED_IRIS_RESULT)).toThrow(/nothing to place/);
	});
});

describe("the image fixtures are real images", () => {
	const decode = (b64: string) => decodeFixture(b64);

	it("decode to JPEGs, not to arbitrary bytes", () => {
		for (const b64 of [SAMPLE_GARMENT_REFERENCE_BASE64, SAMPLE_GARMENT_OUTPUT_BASE64]) {
			const bytes = decode(b64);
			// SOI marker at the front, EOI at the back. `new Uint8Array([1,2,3])`
			// writes to R2 fine, serves fine and returns 200 fine — this is what
			// separates a fixture that proves something from one that does not.
			expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
			expect([bytes[bytes.length - 2], bytes[bytes.length - 1]]).toEqual([0xff, 0xd9]);
			expect(bytes.length).toBeGreaterThan(1000);
			// Comfortably under the ~50KB the ticket asks for.
			expect(bytes.length).toBeLessThan(50_000);
		}
	});

	it("are two DIFFERENT images", () => {
		// Reusing one file for both the fake input and the fake output would hide
		// a bug where the pipeline never reads garment_ref at all, because the
		// test would pass either way.
		expect(SAMPLE_GARMENT_REFERENCE_BASE64).not.toBe(SAMPLE_GARMENT_OUTPUT_BASE64);
	});

	it("match the .jpg files on disk, so the two cannot drift", () => {
		// The .jpg files are the authoring source — open them, look at them,
		// replace them. This module is what ships in the bundle. Regenerating one
		// without the other is the drift this catches.
		const onDisk = (name: string) => readFileSync(join(__dirname, name)).toString("base64");

		expect(onDisk("sample-garment-reference.jpg")).toBe(SAMPLE_GARMENT_REFERENCE_BASE64);
		expect(onDisk("sample-garment-output.jpg")).toBe(SAMPLE_GARMENT_OUTPUT_BASE64);
	});

	it("declare the dimensions the JPEG headers actually carry", () => {
		// The fake reports these as the placement output's width and height, and
		// they end up on the AtlasResult. A wrong pair here is how somebody later
		// concludes a resize is misbehaving when nothing resized at all.
		for (const b64 of [SAMPLE_GARMENT_REFERENCE_BASE64, SAMPLE_GARMENT_OUTPUT_BASE64]) {
			expect(readJpegSize(decode(b64))).toEqual({
				width: SAMPLE_IMAGE_WIDTH,
				height: SAMPLE_IMAGE_HEIGHT,
			});
		}
	});
});

/** Width and height from a baseline JPEG's SOF marker. */
function readJpegSize(bytes: Uint8Array): { width: number; height: number } {
	let offset = 2; // past SOI
	while (offset < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset++;
			continue;
		}
		const marker = bytes[offset + 1]!;
		// SOF0..SOF3 and SOF5..SOF7 carry the frame dimensions.
		if (marker >= 0xc0 && marker <= 0xc3) {
			return {
				height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
				width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
			};
		}
		offset += 2 + ((bytes[offset + 2]! << 8) | bytes[offset + 3]!);
	}
	throw new Error("no SOF marker: not a baseline JPEG");
}
