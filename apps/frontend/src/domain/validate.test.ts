import { describe, expect, it } from 'vitest';
import { validateGenerate, validateIrisGenerate } from './validate';

/**
 * The regression this file exists for: `design_session_id` was added to
 * `HeliosRequestSchema` and this page never started sending it, so every
 * Generate failed validation before it left the browser. Nothing caught it
 * because nothing tested the request this page actually builds.
 */

const CONCEPT = 'art deco paisley with fine linework';
const DESIGN = '9d1e5b70-0a3c-4a3a-9e6f-2c7a1f0b4d55';

describe('validateGenerate', () => {
	it('builds a request carrying the design session id', () => {
		const result = validateGenerate({ concept: CONCEPT, designSessionId: DESIGN, sessionId: 'my-session' });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.request.design_session_id).toBe(DESIGN);
		expect(result.request.concept).toBe(CONCEPT);
		expect(result.request.session_id).toBe('my-session');
	});

	/**
	 * The two ids are handled differently and that difference is the point: a
	 * blank session id means "the shared default instance", and there is no
	 * default design.
	 */
	it('omits a blank session id rather than sending an empty string', () => {
		const result = validateGenerate({ concept: CONCEPT, designSessionId: DESIGN, sessionId: '' });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect('session_id' in result.request).toBe(false);
	});

	it('refuses a blank design session id, naming the field', () => {
		const result = validateGenerate({ concept: CONCEPT, designSessionId: '', sessionId: '' });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain('design_session_id');
	});

	it('still refuses an empty concept', () => {
		expect(validateGenerate({ concept: '   ', designSessionId: DESIGN, sessionId: '' }).ok).toBe(false);
	});

	it('still refuses a concept over the schema maximum', () => {
		expect(validateGenerate({ concept: 'a'.repeat(1001), designSessionId: DESIGN, sessionId: '' }).ok).toBe(false);
	});
});

describe('validateIrisGenerate', () => {
	const MOTIF = 'patterns/9c1760bb-a63e-4f6f-9ef8-c78cdcb417fa.jpg';

	it('builds a request carrying the motif ref and the design id', () => {
		const result = validateIrisGenerate({
			concept: 'deep navy and gold, rich and opulent',
			motifRef: MOTIF,
			designSessionId: DESIGN,
			sessionId: 'my-session',
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.request.motif_ref).toBe(MOTIF);
		expect(result.request.design_session_id).toBe(DESIGN);
	});

	/**
	 * The field with no Helios counterpart, and the one the handoff exists to
	 * fill. Without it there is nothing to colour.
	 */
	it('refuses a missing motif ref, naming the field', () => {
		const result = validateIrisGenerate({
			concept: 'navy and gold',
			motifRef: '',
			designSessionId: DESIGN,
			sessionId: '',
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain('motif_ref');
	});

	it('refuses a missing design session id', () => {
		const result = validateIrisGenerate({
			concept: 'navy and gold',
			motifRef: MOTIF,
			designSessionId: '',
			sessionId: '',
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain('design_session_id');
	});

	it('omits a blank session id rather than sending an empty string', () => {
		const result = validateIrisGenerate({
			concept: 'navy and gold',
			motifRef: MOTIF,
			designSessionId: DESIGN,
			sessionId: '',
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect('session_id' in result.request).toBe(false);
	});
});
