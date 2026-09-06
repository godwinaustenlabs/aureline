import { describe, expect, it } from 'vitest';
import { imageUrlFor, r2KeyFromUrl } from './imageUrl';

const KEY = 'patterns/9c1760bb-a63e-4f6f-9ef8-c78cdcb417fa.jpg';
const BASE = 'https://agent-helios.aureline.workers.dev';

describe('imageUrlFor', () => {
	it('builds the route the engine serves', () => {
		expect(imageUrlFor(BASE, KEY)).toBe(`${BASE}/images/${KEY}`);
	});

	/** A trailing slash is what people type into the base-url field. */
	it('does not produce a double slash', () => {
		expect(imageUrlFor(`${BASE}/`, KEY)).toBe(`${BASE}/images/${KEY}`);
		expect(imageUrlFor(BASE, `/${KEY}`)).toBe(`${BASE}/images/${KEY}`);
	});
});

describe('r2KeyFromUrl', () => {
	/** Iris takes the key, not the URL. This is the conversion between them. */
	it('recovers the key a Helios result was built from', () => {
		expect(r2KeyFromUrl(`${BASE}/images/${KEY}`)).toBe(KEY);
	});

	it('keeps the whole prefixed key, not just the filename', () => {
		expect(r2KeyFromUrl(`${BASE}/images/iris/abc.jpg`)).toBe('iris/abc.jpg');
	});

	/** Guessing here would spend money colouring a motif that does not exist. */
	it('returns null rather than guessing when there is no key to find', () => {
		expect(r2KeyFromUrl('https://example.test/nothing.jpg')).toBeNull();
		expect(r2KeyFromUrl(`${BASE}/images/`)).toBeNull();
		expect(r2KeyFromUrl('')).toBeNull();
	});
});
