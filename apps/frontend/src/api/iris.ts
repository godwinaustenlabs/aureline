import type { IrisRequest } from '@aureline/shared-types';
import { classifyIris, type IrisCallOutcome } from '../domain/irisOutcome';
import { normaliseBaseUrl, send, toFormData } from './client';

/**
 * Every request this page makes to Iris.
 *
 * The same three rules hold as for Helios: no credentials, no retry and no
 * polling, and `Content-Type` is the only header set — anything else fails at
 * preflight against Iris's own `ALLOWED_ORIGINS`.
 */

/** What one Iris generate costs, for the confirm dialog. Planner plus image. */
export const IRIS_GENERATE_COST_USD = 0.0029;

/**
 * `POST /generate`. Billed.
 *
 * Sends JSON when there is no reference image and `multipart/form-data` when
 * there is — see `toFormData` in `api/client.ts` for why no `Content-Type` is
 * set on the second path.
 *
 * On Iris the image reaches the planner only. The image model still receives
 * `motif_ref`, which is Helios's output and the thing Iris exists to colour
 * (ADR-SHARED-0003).
 */
export async function generateIris(
	baseUrl: string,
	request: IrisRequest,
	image?: File | null,
): Promise<IrisCallOutcome> {
	const url = `${normaliseBaseUrl(baseUrl)}/generate`;

	const { status, raw } = image
		? await send(url, { method: 'POST', body: toFormData(request, image) })
		: await send(url, {
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
