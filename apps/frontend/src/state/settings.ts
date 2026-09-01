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
