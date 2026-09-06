import { describe, expect, it } from "vitest";
import { readJpegDimensions } from "@aureline/shared-utils";
import { SAMPLE_COLORED_JPG_BASE64 } from "../fixtures/sample-colored";

/**
 * The one `readJpegDimensions` case that needs a real image.
 *
 * The parser itself lives in `shared-utils` and is tested there against headers
 * that file builds by hand — which is the only way to pin the byte order, since
 * a square image cannot tell a correct parser from one reading width and height
 * the wrong way round.
 *
 * This test is the complement: it proves the parser survives an actual
 * encoder's output, quirks and intervening segments included. It stays here
 * because the fixture does, and the fixture stays here because `test-env.ts`
 * feeds it to the fake `AI` binding as the model's reply — the same bytes the
 * pipeline measures in production.
 */
describe("readJpegDimensions, against the real fixture", () => {
	it("reads the sample motif's dimensions", () => {
		// sample-colored.jpg is 128x128, confirmed against the file itself.
		expect(readJpegDimensions(decodeBase64(SAMPLE_COLORED_JPG_BASE64))).toEqual({
			width: 128,
			height: 128,
		});
	});
});

/** The same `atob` decode the colorizer and the shared helpers use. */
function decodeBase64(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
