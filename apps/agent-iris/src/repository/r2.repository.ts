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

/**
 * Reads the motif Iris is about to colour, from wherever `motif_ref` points.
 *
 * Two forms, because the contract allows two (`IrisRequestSchema.motif_ref` is
 * "an R2 key or a URL"):
 *
 * - **A URL.** This is the form a real run actually takes. Helios returns
 *   `${origin}/images/patterns/{pipeline_id}.jpg` from its own pipeline, so a
 *   caller wiring the two engines together copies a URL across, not a key.
 * - **An R2 key**, read through this Worker's `PATTERNS` binding.
 *
 * One trap on the key form, and it is not obvious from the binding name. Iris's
 * `PATTERNS` is `images-bucket`; Helios's identically-named `PATTERNS` is
 * `helios-bucket`. They are different buckets. A key that Helios wrote resolves
 * here only if someone copied the object across by hand, which is exactly how
 * `patterns/motif.jpg` came to exist in `images-bucket` for local testing. The
 * URL form has no such limitation and is the one to prefer.
 *
 * Throws, naming the ref, on every failure path. This read happens **before**
 * the image model is called, so a failure here costs nothing — which is only
 * true as long as it stays a throw rather than a degraded empty result
 * (AGENTS.md §7).
 */
export async function readMotif(
	bucket: R2Bucket,
	motifRef: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
	const { bytes, contentType } = isHttpUrl(motifRef)
		? await readMotifOverHttp(motifRef)
		: await readMotifFromBucket(bucket, motifRef);

	// An object that exists but holds nothing is a different failure from one
	// that is missing, and it is the more dangerous of the two: zero bytes would
	// go to the model as a valid-looking empty part and bill for a result that
	// could not possibly be right.
	if (bytes.byteLength === 0) {
		throw new Error(`motif "${motifRef}" is empty (zero bytes)`);
	}

	return { bytes, contentType };
}

/**
 * Whether the ref is a URL this can fetch, rather than an R2 key.
 *
 * A prefix test, not `new URL()`: that parses `data:` and `file:` happily, and
 * anything other than HTTP reaching `fetch` here is a bug worth surfacing as a
 * missing key rather than an opaque fetch failure.
 */
function isHttpUrl(motifRef: string): boolean {
	return motifRef.startsWith("http://") || motifRef.startsWith("https://");
}

/** The URL form. Any non-2xx is fatal and names the status. */
async function readMotifOverHttp(url: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
	let response: Response;

	try {
		response = await fetch(url);
	} catch (cause) {
		// A DNS failure or a refused connection arrives as a throw, not a status.
		// Rewrapped so the message names the ref, because the bare cause does not.
		throw new Error(`could not fetch motif "${url}": ${cause instanceof Error ? cause.message : String(cause)}`);
	}

	if (!response.ok) {
		throw new Error(`could not fetch motif "${url}": HTTP ${response.status}`);
	}

	return {
		bytes: new Uint8Array(await response.arrayBuffer()),
		contentType: response.headers.get("content-type") ?? FALLBACK_MOTIF_CONTENT_TYPE,
	};
}

/** The R2-key form. A miss is fatal and says which bucket was searched. */
async function readMotifFromBucket(
	bucket: R2Bucket,
	key: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
	const object = await bucket.get(key);

	if (!object) {
		throw new Error(
			`motif "${key}" not found in Iris's bucket. If Helios wrote it, note that ` +
				`Helios writes to a different bucket and the object has to be copied across; ` +
				`passing the URL Helios returned avoids this entirely.`,
		);
	}

	return {
		bytes: new Uint8Array(await object.arrayBuffer()),
		contentType: object.httpMetadata?.contentType ?? FALLBACK_MOTIF_CONTENT_TYPE,
	};
}

/**
 * Used when neither R2 nor the HTTP response declares a type.
 *
 * Deliberately not `application/octet-stream`, which is what `GET /images/*`
 * falls back to when serving. These bytes become a multipart part handed to an
 * image model, and a part typed as arbitrary binary is a part the model has no
 * reason to treat as an image. Every motif in play is a JPEG.
 */
const FALLBACK_MOTIF_CONTENT_TYPE = "image/jpeg";
