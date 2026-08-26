import type { AtlasPlacement } from "@aureline/shared-types";
import type { AtlasConfig } from "../config";
import {
	SAMPLE_GARMENT_OUTPUT_BASE64,
	SAMPLE_IMAGE_HEIGHT,
	SAMPLE_IMAGE_WIDTH,
	decodeFixture,
} from "../fixtures/sample-images";

/**
 * Places a pattern onto a garment and returns the resulting image bytes.
 *
 * ============================================================================
 * THE BODY OF `placePattern` IS FAKE. atlas-07 replaces it with the real
 * image-to-image call. **The signature below is already the final one**, so
 * that ticket changes a function body and not a single call site.
 * ============================================================================
 *
 * When atlas-07 lands, this function will:
 *   - fetch `patternRef` (a URL, or an R2 key under Iris's `iris/` prefix in
 *     the shared bucket) and `garmentRef` (always a URL this sprint), both
 *     through `repository/`, never with a bare `fetch` from here
 *   - resize each independently to the model's input limit, preserving each
 *     one's own aspect ratio — they do not share a source size, and stretching
 *     either to a square reads as a model problem when it is really the resize
 *   - call `getImageToImageOutput` from `packages/shared-utils` (built by
 *     iris-07, used here unchanged) with the pattern as `input_image_0` and the
 *     garment as `input_image_1`, in that order — `buildPlacementPrompt`'s text
 *     refers to "the first image" and "the second image"
 *   - skip the gateway cache, or a resume would return the first attempt while
 *     still billing for a second
 *   - read the real cost with `readGatewayCost(env, "image")` immediately after
 *
 * Until then it returns a fixture image and `cost_usd: null`.
 */

/** What the placement call returns. Raw bytes only — **it does not know R2
 * exists.** The pipeline saves. That separation is what lets this be tested
 * without a bucket, and it is the same shape both other engines use. */
export interface PlacementOutput {
	image: Uint8Array;
	contentType: string;
	width: number;
	height: number;
	cost_usd: number | null;
}

/**
 * @param patternRef - Iris's `image_url` or R2 key. Ignored by the fake.
 * @param garmentRef - URL of the caller's garment photo. Ignored by the fake.
 * @param placement - What to place and where. Ignored by the fake.
 * @param config - The resolved config for this invocation. Ignored by the fake.
 * @param env - Bindings. **The fake must never touch `env.AI`.**
 * @param pipeline_id - This invocation, for the gateway log. Ignored by the fake.
 */
export async function placePattern(
	patternRef: string,
	garmentRef: string,
	placement: AtlasPlacement,
	config: AtlasConfig,
	env: Env,
	pipeline_id: string,
): Promise<PlacementOutput> {
	// Every parameter is accepted and ignored, deliberately. Taking the real
	// arguments now is what keeps atlas-07 a body swap. Referenced here only so
	// the unused-parameter warnings do not tempt anyone into deleting them.
	void patternRef;
	void garmentRef;
	void placement;
	void config;
	void env;
	void pipeline_id;

	return {
		image: decodeFixture(SAMPLE_GARMENT_OUTPUT_BASE64),
		contentType: "image/jpeg",
		width: SAMPLE_IMAGE_WIDTH,
		height: SAMPLE_IMAGE_HEIGHT,
		// Nothing was billed. The real call reports what the AI Gateway logged.
		cost_usd: null,
	};
}
