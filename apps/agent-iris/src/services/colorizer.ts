import type { IrisParams } from "@aureline/shared-types";
import type { IrisConfig } from "../config";
import { SAMPLE_COLORED_JPG_BASE64 } from "../fixtures/sample-colored";

/** The fixture's actual pixel dimensions (`fixtures/sample-colored.jpg`). */
const SAMPLE_WIDTH = 128;
const SAMPLE_HEIGHT = 128;

/**
 * Decodes a base64 string into raw bytes using the standard `atob` global,
 * available identically under Workers and under Node's Vitest runner — unlike
 * a raw `.jpg` module import, which the two bundlers disagree on.
 */
function decodeBase64(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/**
 * Image colorization stage: colors an existing motif according to the
 * planner's parameters.
 *
 * Faked for iris-05. iris-09 replaces this body with a real image-to-image
 * call, and keeps this exact signature — it swaps out a function body, not a
 * call site.
 *
 * Returns raw bytes only. It does not know R2 exists (that is the pipeline's
 * job) and does not build a URL.
 *
 * The fixture is a real, small, actually-colored JPEG
 * (`fixtures/sample-colored.jpg`), not random bytes: it has to survive being
 * written to R2, served back through `GET /images/*`, and displayed in a
 * browser, which random bytes would pass every test for and fail the one
 * thing the fixture is for.
 */
export async function colorizeMotif(
	motifRef: string,
	params: IrisParams,
	config: IrisConfig,
	env: Env,
	p_invoc_id: string,
): Promise<{ image: Uint8Array; contentType: string; width: number; height: number; cost_usd: number | null }> {
	return {
		image: decodeBase64(SAMPLE_COLORED_JPG_BASE64),
		contentType: "image/jpeg",
		width: SAMPLE_WIDTH,
		height: SAMPLE_HEIGHT,
		cost_usd: null,
	};
}
