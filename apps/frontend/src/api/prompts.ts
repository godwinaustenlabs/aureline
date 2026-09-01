/**
 * The prompt editor's calls. Same-origin, to this playground's own worker.
 *
 * Unlike everything in `client.ts`, these do not go to an engine and do not
 * take a base URL — the engines deliberately have no prompt route. The
 * playground owns the path to the `prompts` table and reaches it through a D1
 * binding held by the worker that serves this page.
 *
 * **Nothing here spends money.** Every call is a database read or write, which
 * is what makes the load is safe to do from an effect — unlike `/generate`,
 * which is why that one is behind a confirm dialog.
 */

export type EngineName = 'iris' | 'helios';

/** One slot as the editor sees it. `promptText` is null when no row exists yet. */
export interface PromptView {
	slot: string;
	promptText: string | null;
	updatedAt: string | null;
}

export type PromptsOutcome = { ok: true; prompts: PromptView[] } | { ok: false; message: string };
export type SaveOutcome = { ok: true; updatedAt: string | null } | { ok: false; message: string };

/** The worker answers `{ error }` on every refusal, so failures read the same way. */
async function messageFrom(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: unknown };
		if (typeof body.error === 'string') return body.error;
	} catch {
		// Falls through to the status line below.
	}
	return `${response.status} ${response.statusText}`;
}

export async function listPrompts(engine: EngineName): Promise<PromptsOutcome> {
	try {
		const response = await fetch(`/api/prompts?engine=${engine}`);
		if (!response.ok) return { ok: false, message: await messageFrom(response) };

		const body = (await response.json()) as { prompts?: unknown };
		if (!Array.isArray(body.prompts)) return { ok: false, message: 'the worker returned no prompts array' };

		return { ok: true, prompts: body.prompts as PromptView[] };
	} catch (cause) {
		// Under `npm run dev` this is the usual failure: Vite serves the page but
		// not the worker, so there is no /api to reach. Say so rather than
		// showing a bare "Failed to fetch".
		return {
			ok: false,
			message: `could not reach /api/prompts (${cause instanceof Error ? cause.message : 'unknown error'}). Is the playground worker running?`,
		};
	}
}

export async function savePrompt(engine: EngineName, slot: string, promptText: string): Promise<SaveOutcome> {
	try {
		const response = await fetch('/api/prompts', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ engine, slot, prompt_text: promptText }),
		});
		if (!response.ok) return { ok: false, message: await messageFrom(response) };

		const body = (await response.json()) as { updated_at?: unknown };
		return { ok: true, updatedAt: typeof body.updated_at === 'string' ? body.updated_at : null };
	} catch (cause) {
		return { ok: false, message: cause instanceof Error ? cause.message : 'unknown error' };
	}
}
