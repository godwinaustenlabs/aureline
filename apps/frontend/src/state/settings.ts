/**
 * The base URL is configuration, not a constant.
 *
 * Local dev is `http://localhost:8787` and production is the deployed worker's
 * hostname, and the same build has to be able to point at either — so it is a
 * field in the UI as well as a build-time default. Nobody should have to rebuild
 * to aim at the other one.
 */

const STORAGE_KEY = 'helios-playground.baseUrl';

/** The build-time default. `VITE_API_BASE_URL` overrides it at build time; the
 *  field in the UI overrides that at runtime. */
export const DEFAULT_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787';

export function loadBaseUrl(): string {
	try {
		return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_BASE_URL;
	} catch {
		return DEFAULT_BASE_URL;
	}
}

export function saveBaseUrl(baseUrl: string): void {
	try {
		localStorage.setItem(STORAGE_KEY, baseUrl);
	} catch {
		// Losing the persisted value only costs a retype on the next page load.
	}
}

/**
 * Iris's base URL, stored separately from Helios's.
 *
 * Two fields and not one, because the two engines are two Workers on two hosts.
 * A single field would mean pointing at Iris to colour a motif and then having
 * to point back to generate the next pattern — and getting it wrong sends a
 * Helios body to Iris, which is a 400 on the missing `motif_ref`.
 *
 * The default is the deployed worker rather than localhost, unlike Helios's:
 * running Iris locally bills the same models and there is no local motif to
 * colour anyway, since `motif_ref` names an object in the shared R2 bucket.
 */
const IRIS_STORAGE_KEY = 'iris-playground.baseUrl';

export const DEFAULT_IRIS_BASE_URL =
	import.meta.env.VITE_IRIS_API_BASE_URL ?? 'https://agent-iris.aureline.workers.dev';

export function loadIrisBaseUrl(): string {
	try {
		return localStorage.getItem(IRIS_STORAGE_KEY) ?? DEFAULT_IRIS_BASE_URL;
	} catch {
		return DEFAULT_IRIS_BASE_URL;
	}
}

export function saveIrisBaseUrl(baseUrl: string): void {
	try {
		localStorage.setItem(IRIS_STORAGE_KEY, baseUrl);
	} catch {
		// Losing the persisted value only costs a retype on the next page load.
	}
}
