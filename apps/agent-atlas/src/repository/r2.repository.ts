/**
 * R2 repository for garment images. All R2 access lives here — the pipeline
 * only calls these two functions, in both directions.
 *
 * The key prefix names the ENGINE, not the file type. Helios uses
 * `patterns/{pipeline_id}.jpg` because it still has its own bucket; Atlas and
 * Iris share `images-bucket` (atlas-02 decision 5), so the engine is now the
 * thing that needs distinguishing on the key.
 */

const ATLAS_PREFIX = "atlas";

/**
 * Saves the image and returns its key.
 * Key format: atlas/{pipeline_id}.jpg
 *
 * Derived from the invocation id rather than random, so an object can always be
 * found again without a lookup.
 */
export async function saveGarmentImage(
	bucket: R2Bucket,
	pipelineId: string,
	image: Uint8Array,
	contentType: string,
): Promise<string> {
	const key = `${ATLAS_PREFIX}/${pipelineId}.jpg`;

	await bucket.put(key, image, {
		httpMetadata: {
			contentType,
		},
	});

	return key;
}

/**
 * Reads an image back. Returns null when the key does not exist.
 *
 * Reads any key in the bucket, not only Atlas's own prefix. That is deliberate:
 * Iris writes `iris/{pipeline_id}.jpg` into this same bucket, and atlas-07 needs
 * to read an Iris pattern through here when `pattern_ref` is an R2 key rather
 * than a URL. No cross-bucket access is involved.
 */
export async function readGarmentImage(
	bucket: R2Bucket,
	key: string,
): Promise<R2ObjectBody | null> {
	const object = await bucket.get(key);
	return object;
}
