import { ENGINE_SPECS, isEngine, type Engine } from '../domain/engines';

/**
 * Which engine the page is driving, and where each one lives.
 *
 * **The base URL is configuration, not a constant.** Local dev and a deployed
 * worker are different hosts, and the same build has to point at either — so it
 * is a field in the UI as well as a build-time default. Nobody should have to
 * rebuild to aim at the other one.
 *
 * **The base URL is stored per engine.** Sharing one across all three is the
 * mistake that costs a wrong-engine call: you switch to Iris, the field still
 * holds Helios's URL, you click generate, and Helios receives a body with
 * `motif_ref` in it. Zod strips unknown keys by default, so it does not error —
 * it runs a perfectly normal Helios generate and bills you for it.
 *
 * **The engine is chosen explicitly and never inferred from the URL.** Guessing
 * from the hostname breaks the moment two workers are both on `*.workers.dev`,
 * and it breaks silently, by sending the wrong request shape.
 */

const ENGINE_KEY = 'aureline-playground.engine';
const BASE_URL_KEY = (engine: Engine) => `aureline-playground.baseUrl.${engine}`;

/** Kept so an existing tester's saved Helios URL survives the upgrade rather
 *  than silently reverting to the default on their next page load. */
const LEGACY_HELIOS_KEY = 'helios-playground.baseUrl';

/** A build-time override, applied to whichever engine is selected. Left as a
 *  single var because that is what the deploy pipeline sets. */
const BUILD_TIME_BASE_URL: string | undefined = import.meta.env.VITE_API_BASE_URL;

export function defaultBaseUrl(engine: Engine): string {
	return BUILD_TIME_BASE_URL ?? ENGINE_SPECS[engine].defaultBaseUrl;
}

export function loadEngine(): Engine {
	try {
		const stored = localStorage.getItem(ENGINE_KEY);
		return isEngine(stored) ? stored : 'helios';
	} catch {
		return 'helios';
	}
}

export function saveEngine(engine: Engine): void {
	try {
		localStorage.setItem(ENGINE_KEY, engine);
	} catch {
		// Losing the persisted value costs one click on the next page load.
	}
}

export function loadBaseUrl(engine: Engine): string {
	try {
		const stored = localStorage.getItem(BASE_URL_KEY(engine));
		if (stored) return stored;

		// One-time carry-over from the single-engine era.
		if (engine === 'helios') {
			const legacy = localStorage.getItem(LEGACY_HELIOS_KEY);
			if (legacy) return legacy;
		}

		return defaultBaseUrl(engine);
	} catch {
		return defaultBaseUrl(engine);
	}
}

export function saveBaseUrl(engine: Engine, baseUrl: string): void {
	try {
		localStorage.setItem(BASE_URL_KEY(engine), baseUrl);
	} catch {
		// Losing the persisted value only costs a retype on the next page load.
	}
}
