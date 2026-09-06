import { IrisResultSchema, type IrisResult } from '@aureline/shared-types';

/**
 * What one call to Iris turned out to be.
 *
 * The same three classes as `outcome.ts`, and separate from it on purpose: the
 * two engines return different bodies, and a single union covering both would
 * have to be narrowed at every use.
 *
 * One real difference from the Helios version. `IrisResult` is a **zod schema**
 * where `HeliosResult` is a bare interface, so this validates instead of
 * hand-checking two fields. That is the shape of the contract, not a preference
 * — Atlas consumes Iris's result across a worker boundary and needs to validate
 * it at runtime, so the schema had to exist anyway.
 */
export type IrisCallOutcome =
	| { kind: 'run'; result: IrisResult; raw: string }
	| { kind: 'refusal'; reason: string; raw: string }
	| { kind: 'transport'; message: string; status: number | null; raw: string };

/**
 * Turns one HTTP answer from Iris into an outcome.
 *
 * **`status` is what decides, never `response.ok`.** A failed Iris run is a 200
 * carrying `status: "failed"` — it ran, it billed, and it did not work. Treating
 * that as an error would hide a run that cost money.
 */
export function classifyIris(status: number | null, raw: string): IrisCallOutcome {
	if (status === null) {
		return { kind: 'transport', message: raw || 'the request never reached Iris', status: null, raw };
	}

	const body = parseJson(raw);

	if (status === 200) {
		const parsed = IrisResultSchema.safeParse(body);
		// A 200 whose body is not a result is a transport failure, not a run:
		// something answered, but not the pipeline. Calling it a run invents one.
		return parsed.success
			? { kind: 'run', result: parsed.data, raw }
			: { kind: 'transport', message: `Iris answered 200 with a body that is not an IrisResult: ${parsed.error.issues[0]?.message ?? 'invalid'}`, status, raw };
	}

	// 409 is a resume precondition, exactly as in Helios: nothing ran, nothing
	// was billed, and the reason is written to be shown verbatim.
	if (status === 409) {
		const reason = typeof (body as { error?: unknown })?.error === 'string' ? (body as { error: string }).error : raw;
		return { kind: 'refusal', reason, raw };
	}

	const message = typeof (body as { error?: unknown })?.error === 'string' ? (body as { error: string }).error : raw;
	return { kind: 'transport', message, status, raw };
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
