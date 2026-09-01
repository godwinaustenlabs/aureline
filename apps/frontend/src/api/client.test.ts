import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HeliosRequest } from '@aureline/shared-types';
import { generate, normaliseBaseUrl, toFormData } from './client';

/**
 * How a run reaches the worker, and specifically which body shape it uses.
 *
 * `fetch` is stubbed rather than mocked at the module level so these assert on
 * the real `RequestInit` the browser would have been handed — the thing that
 * actually decides whether the worker can parse the request.
 */

const REQUEST: HeliosRequest = {
	concept: 'art deco paisley',
	design_session_id: 'design-1',
	session_id: 'studio-a',
};

function stubFetch() {
	const fetchMock = vi.fn(async () => new Response('{"status":"completed"}', { status: 200 }));
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

/** The `RequestInit` handed to the one call that was made. */
function initOf(fetchMock: ReturnType<typeof stubFetch>): RequestInit {
	return (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('generate', () => {
	it('sends JSON, exactly as before, when there is no reference image', async () => {
		// The regression promise: a run without an image has to produce the same
		// request it always did, header and body alike.
		const fetchMock = stubFetch();

		await generate('https://helios.example.com', REQUEST);

		const init = initOf(fetchMock);
		expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
		expect(init.body).toBe(JSON.stringify(REQUEST));
	});

	it('sends JSON when the image argument is null', async () => {
		// `null` is what the app holds when the user cleared the file input, and it
		// has to mean "no image" rather than "an image that is null".
		const fetchMock = stubFetch();

		await generate('https://helios.example.com', REQUEST, null);

		expect(initOf(fetchMock).headers).toEqual({ 'Content-Type': 'application/json' });
	});

	it('sends multipart form data when a reference image is attached', async () => {
		const fetchMock = stubFetch();
		const file = new File([new Uint8Array([137, 80, 78, 71])], 'ref.png', { type: 'image/png' });

		await generate('https://helios.example.com', REQUEST, file);

		const init = initOf(fetchMock);
		expect(init.body).toBeInstanceOf(FormData);
	});

	it('sets no Content-Type of its own on the multipart path', async () => {
		// Load-bearing. The browser writes the header itself, including the
		// `boundary=` parameter that says where each part begins. Setting it by
		// hand omits the boundary, and the worker then cannot parse the body at
		// all — failing with a schema error that points nowhere near the cause.
		const fetchMock = stubFetch();
		const file = new File([new Uint8Array([1])], 'ref.png', { type: 'image/png' });

		await generate('https://helios.example.com', REQUEST, file);

		expect(initOf(fetchMock).headers).toBeUndefined();
	});
});

describe('toFormData', () => {
	const file = new File([new Uint8Array([137, 80, 78, 71])], 'ref.png', { type: 'image/png' });

	it('carries every text field and the file under the name the engine reads', () => {
		const form = toFormData(REQUEST, file);

		expect(form.get('concept')).toBe('art deco paisley');
		expect(form.get('design_session_id')).toBe('design-1');
		expect(form.get('session_id')).toBe('studio-a');
		// `image`, and nothing else. Renaming it produces a request with no image
		// and no error anywhere.
		expect(form.get('image')).toBe(file);
	});

	it('drops an absent optional field rather than sending the string "undefined"', () => {
		// `session_id` omitted means "the shared default instance". Sent as the
		// literal text "undefined" it becomes a real Durable Object of that name,
		// with its own history, which nothing would ever report as wrong.
		const form = toFormData({ concept: 'art deco paisley', session_id: undefined }, file);

		expect(form.has('session_id')).toBe(false);
	});
});

describe('normaliseBaseUrl', () => {
	it('strips trailing slashes, which produce a double slash that routes nowhere', () => {
		expect(normaliseBaseUrl(' https://helios.example.com// ')).toBe('https://helios.example.com');
	});
});
