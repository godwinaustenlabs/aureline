/**
 * Turning a stored R2 key into something the browser can load.
 *
 * The engines never store a URL. They store a key — `patterns/{pipeline_id}.jpg`
 * for Helios, `iris/{pipeline_id}.jpg` for Iris — and build a URL from it at
 * response time using the origin the request arrived on. A row read back from
 * `GET /runs` therefore has a key and no URL, which is why picking a run out of
 * the history used to show every field the engine recorded and no image: nothing
 * reassembled the URL.
 */

/** `${baseUrl}/images/${key}`, which is the route both engines serve. */
export function imageUrlFor(baseUrl: string, r2Key: string): string {
	return `${baseUrl.trim().replace(/\/+$/, '')}/images/${r2Key.replace(/^\/+/, '')}`;
}

/**
 * The R2 key back out of a URL the engine built.
 *
 * This is what Iris needs: its `motif_ref` is the Helios **key**, not the URL, so
 * handing a Helios result straight to Iris means undoing `imageUrlFor`. Returns
 * null rather than guessing when the URL has no `/images/` segment — a wrong
 * motif_ref is a billed run against a motif that does not exist.
 */
export function r2KeyFromUrl(imageUrl: string): string | null {
	const marker = '/images/';
	const at = imageUrl.indexOf(marker);
	if (at === -1) return null;

	const key = imageUrl.slice(at + marker.length).trim();
	return key.length > 0 ? key : null;
}
