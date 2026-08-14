/**
 * The session id, which is the whole mechanism.
 *
 * A session id **is** the Durable Object's name (ADR-0005). Send the same string
 * and you land in the same DO, with the same history and the same runs available
 * to resume; send a different one and you get a store that shares nothing with
 * it. There is nothing else to switch.
 *
 * **The list of previous ids has to live in `localStorage`, and that is a
 * limitation rather than a design.** There is no route that lists sessions and
 * there cannot easily be one: Durable Objects are addressed by name and cannot
 * be enumerated, and `helios_runs` carries no session column in either the DO or
 * D1, so even the permanent copy cannot say which sessions exist. An id this
 * browser never used is unreachable through the picker and has to be typed.
 */

const STORAGE_KEY = 'helios-playground.sessions';

/** Enough to pick from, few enough that the list stays usable. */
const MAX_REMEMBERED = 25;

export interface RememberedSession {
	id: string;
	/** ISO, so the list can be shown newest first and stay readable in devtools. */
	lastUsedAt: string;
}

/**
 * The id as it will actually be sent.
 *
 * Trimmed **and lowercased**. The worker hashes the name exactly, so `Test`,
 * `test` and `test ` would otherwise be three different Durable Objects and two
 * of them are not the one anybody meant. The UI shows the result of this so the
 * normalisation is visible rather than surprising.
 */
export function normaliseSessionId(raw: string): string {
	return raw.trim().toLowerCase();
}

/**
 * What an empty session id actually means.
 *
 * Not "no session": the worker falls back to a shared Durable Object literally
 * named `default`, which is where every run made without an id has ever gone. It
 * is a real store with a real history, not a blank slate.
 */
export const DEFAULT_SESSION = 'default';

/** The DO a given field value will reach. */
export function effectiveSession(raw: string): string {
	return normaliseSessionId(raw) || DEFAULT_SESSION;
}

const ADJECTIVES = [
	'quiet',
	'brisk',
	'amber',
	'hollow',
	'linen',
	'copper',
	'still',
	'woven',
	'plain',
	'silver',
	'narrow',
	'gentle',
] as const;

const NOUNS = [
	'harbor',
	'meadow',
	'thistle',
	'lantern',
	'orchard',
	'anchor',
	'willow',
	'cinder',
	'ridge',
	'basin',
	'shuttle',
	'loom',
] as const;

/**
 * A fresh readable id, `test-quiet-harbor-4f2a`.
 *
 * Random ids are what stop two people testing at once from pruning each other's
 * history out — the Durable Object keeps only the newest few completed runs and
 * prunes on every invocation, so sharing a session means sharing that budget.
 */
export function randomSessionId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(4));
	const adjective = ADJECTIVES[bytes[0]! % ADJECTIVES.length]!;
	const noun = NOUNS[bytes[1]! % NOUNS.length]!;
	const suffix = [bytes[2]!, bytes[3]!].map((byte) => byte.toString(16).padStart(2, '0')).join('');

	return `test-${adjective}-${noun}-${suffix}`;
}

/**
 * The list with `id` moved to the front, deduplicated and capped.
 *
 * Pure, so the ordering and dedupe rules are testable without a browser.
 */
export function remember(sessions: readonly RememberedSession[], id: string, now: Date = new Date()): RememberedSession[] {
	const normalised = normaliseSessionId(id);
	if (!normalised) return [...sessions];

	const withoutIt = sessions.filter((session) => session.id !== normalised);
	return [{ id: normalised, lastUsedAt: now.toISOString() }, ...withoutIt].slice(0, MAX_REMEMBERED);
}

/** Drops one id from the list. Forgetting a session does not delete the Durable
 *  Object — the runs are still there for anyone who types the id again. */
export function forget(sessions: readonly RememberedSession[], id: string): RememberedSession[] {
	return sessions.filter((session) => session.id !== id);
}

/** Whatever survived in `localStorage`, most recent first. Never throws: a
 *  corrupted value is worth losing, not worth a blank page. */
export function loadSessions(): RememberedSession[] {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (!stored) return [];
		const parsed: unknown = JSON.parse(stored);
		if (!Array.isArray(parsed)) return [];

		return parsed
			.filter((item): item is RememberedSession => typeof (item as RememberedSession)?.id === 'string')
			.map((item) => ({ id: item.id, lastUsedAt: typeof item.lastUsedAt === 'string' ? item.lastUsedAt : '' }));
	} catch {
		return [];
	}
}

export function saveSessions(sessions: readonly RememberedSession[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
	} catch {
		// A full or disabled store costs us the picker, nothing more. Typing an id
		// still works, and that is the whole mechanism.
	}
}
