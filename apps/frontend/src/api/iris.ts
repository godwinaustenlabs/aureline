import type { IrisRequest } from '@aureline/shared-types';
import { classifyIris, type IrisCallOutcome } from '../domain/irisOutcome';
import { normaliseBaseUrl, send } from './client';

/**
 * Every request this page makes to Iris.
 *
 * The same three rules hold as for Helios: no credentials, no retry and no
 * polling, and `Content-Type` is the only header set — anything else fails at
 * preflight against Iris's own `ALLOWED_ORIGINS`.
 */

/** What one Iris generate costs, for the confirm dialog. Planner plus image. */
export const IRIS_GENERATE_COST_USD = 0.0029;

/** `POST /generate`. Billed. */
export async function generateIris(baseUrl: string, request: IrisRequest): Promise<IrisCallOutcome> {
	const { status, raw } = await send(`${normaliseBaseUrl(baseUrl)}/generate`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(request),
	});

	return classifyIris(status, raw);
}

/** `GET /`. Free, and the cheapest way to find out the base URL is wrong. */
export async function pingIris(baseUrl: string): Promise<{ ok: boolean; message: string }> {
	const { status, raw } = await send(`${normaliseBaseUrl(baseUrl)}/`, { method: 'GET' });
	return status === 200 ? { ok: true, message: raw } : { ok: false, message: status === null ? raw : `HTTP ${status}: ${raw}` };
}
