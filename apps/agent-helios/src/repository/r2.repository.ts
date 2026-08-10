/**
 * R2 repository for pattern images. All R2 access lives here — the pipeline
 * only calls these two functions. See ticket 06.
 */

const PATTERNS_PREFIX = "patterns";

/**
 * Saves the image and returns its key.
 * Key format: patterns/{p_invoc_id}.jpg
 */
export async function savePatternImage(
	bucket: R2Bucket,
	pInvocId: string,
	image: Uint8Array,
	contentType: string,
): Promise<string> {
	const key = `${PATTERNS_PREFIX}/${pInvocId}.jpg`;

	await bucket.put(key, image, {
		httpMetadata: {
			contentType,
		},
	});

	return key;
}

/**
 * Reads an image back. Returns null when the key does not exist.
 */
export async function readPatternImage(
	bucket: R2Bucket,
	key: string,
): Promise<R2ObjectBody | null> {
	const object = await bucket.get(key);
	return object;
}   
