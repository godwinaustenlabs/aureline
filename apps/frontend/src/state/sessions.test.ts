import { describe, expect, it } from 'vitest';
import { DEFAULT_SESSION, effectiveSession, forget, normaliseSessionId, randomSessionId, remember } from './sessions';

describe('normaliseSessionId', () => {
	it('trims and lowercases, so one intended store is not three Durable Objects', () => {
		expect(normaliseSessionId('  Test ')).toBe('test');
		expect(normaliseSessionId('TEST')).toBe('test');
		expect(normaliseSessionId('test')).toBe('test');
	});

	it('is empty for whitespace, which is what the omitted-field case looks like', () => {
		expect(normaliseSessionId('   ')).toBe('');
	});
});

describe('effectiveSession', () => {
	it('names the shared instance an empty id actually reaches', () => {
		// Not "no session": the worker falls back to a real Durable Object named
		// `default`, with a real history in it.
		expect(effectiveSession('')).toBe(DEFAULT_SESSION);
		expect(effectiveSession('  ')).toBe(DEFAULT_SESSION);
		expect(effectiveSession(' Playground ')).toBe('playground');
	});
});

describe('remember', () => {
	it('puts the newest id at the front', () => {
		const list = remember(remember([], 'alpha'), 'beta');
		expect(list.map((session) => session.id)).toEqual(['beta', 'alpha']);
	});

	it('moves an id already in the list rather than duplicating it', () => {
		const list = remember(remember(remember([], 'alpha'), 'beta'), 'alpha');
		expect(list.map((session) => session.id)).toEqual(['alpha', 'beta']);
	});

	it('stores the normalised id, so the picker cannot offer an id that would miss', () => {
		expect(remember([], '  Alpha ')[0]!.id).toBe('alpha');
	});

	it('ignores an empty id — a blank field means the shared default, not a session worth listing', () => {
		expect(remember([], '   ')).toEqual([]);
	});

	it('caps the list', () => {
		let list = remember([], 'seed');
		for (let index = 0; index < 40; index++) list = remember(list, `session-${index}`);

		expect(list.length).toBe(25);
		expect(list[0]!.id).toBe('session-39');
	});
});

describe('forget', () => {
	it('drops one id and leaves the rest', () => {
		const list = remember(remember([], 'alpha'), 'beta');
		expect(forget(list, 'alpha').map((session) => session.id)).toEqual(['beta']);
	});
});

describe('randomSessionId', () => {
	it('is readable, lowercase and prefixed so test stores are recognisable', () => {
		for (let index = 0; index < 50; index++) {
			const id = randomSessionId();
			expect(id).toMatch(/^test-[a-z]+-[a-z]+-[0-9a-f]{4}$/);
			expect(normaliseSessionId(id)).toBe(id);
		}
	});

	it('does not repeat itself in practice, which is what keeps two testers apart', () => {
		const ids = new Set(Array.from({ length: 200 }, randomSessionId));
		expect(ids.size).toBeGreaterThan(190);
	});
});
