import { describe, expect, it } from 'vitest';
import { NO_SPEND, recordCall } from './spend';

describe('recordCall', () => {
	it('adds up the real totals', () => {
		const spend = recordCall(recordCall(NO_SPEND, 0.0029008), 0.0019008);

		expect(spend.calls).toBe(2);
		expect(spend.usd).toBeCloseTo(0.0048016, 10);
		expect(spend.approximate).toBe(false);
	});

	it('still counts a call whose cost could not be read, and marks the total a floor', () => {
		const spend = recordCall(recordCall(NO_SPEND, 0.0029008), null);

		expect(spend.calls).toBe(2);
		expect(spend.usd).toBeCloseTo(0.0029008, 10);
		// The money left the account either way. Saying "at least" is honest;
		// silently under-reporting is not.
		expect(spend.approximate).toBe(true);
	});

	it('stays approximate once it has been', () => {
		expect(recordCall(recordCall(NO_SPEND, null), 0.001).approximate).toBe(true);
	});
});
