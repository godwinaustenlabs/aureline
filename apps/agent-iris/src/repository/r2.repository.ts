/**
 * R2 repository for Iris's coloured output. All R2 access lives here — the
 * pipeline only calls these two functions.
 *
 * The binding is called `PATTERNS`, which holds Iris's coloured output here,
 * not patterns. That is deliberate, not a copy-paste mistake: the name is
 * identical across all three engines so this file reads the same everywhere,
 * and the bucket itself is shared with Atlas (see the comment above
 * `r2_buckets` in wrangler.jsonc for the full reasoning). Separation between
 * engines happens by key prefix, not by bucket — Iris writes
 * `iris/{pipeline_id}.jpg`, Helios writes `patterns/{pipeline_id}.jpg`, and Atlas
 * writes `atlas/{pipeline_id}.jpg`.
 */

const IRIS_PREFIX = "iris";

/**
 * Saves the coloured image and returns its key.
 * Key format: iris/{pipeline_id}.jpg
 */
export async function saveColoredImage(
	bucket: R2Bucket,
	pipelineId: string,
	image: Uint8Array,
	contentType: string,
): Promise<string> {
	const key = `${IRIS_PREFIX}/${pipelineId}.jpg`;

	await bucket.put(key, image, {
		httpMetadata: {
			contentType,
		},
	});

	return key;
}

/**
 * Reads a coloured image back. Returns null when the key does not exist.
 */
export async function readColoredImage(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
	return bucket.get(key);
}
