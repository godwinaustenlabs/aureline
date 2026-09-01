import { useCallback, useEffect, useState } from 'react';
import { listPrompts, savePrompt, type EngineName, type PromptView } from '../api/prompts';

/**
 * The prompt editor.
 *
 * One box per slot; saving overwrites that slot's row. There is no version
 * picker and no delete button, because the table holds exactly one row per slot
 * — "route to a different prompt" and "edit the prompt" are the same action, so
 * there is nothing to switch between and nothing a delete would mean.
 *
 * A saved prompt is live on the engine's **next request**, with no deploy. That
 * is the entire point of the screen, and it is why the warning below is not
 * decoration: there is no staging step between this textarea and a model call
 * that spends real money.
 *
 * Loading is done in an effect, unlike everything in `App.tsx`, and that is safe
 * for one specific reason: these calls are database reads and writes against the
 * playground's own worker. Nothing here reaches a model. Saving is still behind
 * a click, because a save changes what the engine sends.
 */

/** What each slot is, in words, so the screen does not need the reader to know. */
const SLOT_LABELS: Record<string, string> = {
	iris_planner: 'Planner system prompt — turns a brief into colour parameters',
	iris_color: 'Colour prompt — turns those parameters into a sentence for the image model',
	helios_planner: 'Planner system prompt — turns a brief into pattern parameters',
	helios_image: 'Image prompt — turns those parameters into a sentence for Flux',
};

/** The slots the engine reads today. The rest are stored but not yet wired up. */
const LIVE_SLOTS = new Set(['iris_planner', 'helios_planner']);

export function PromptsPanel() {
	const [engine, setEngine] = useState<EngineName>('iris');
	const [prompts, setPrompts] = useState<PromptView[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const load = useCallback(async (which: EngineName) => {
		setLoading(true);
		setError(null);
		const outcome = await listPrompts(which);
		setLoading(false);

		if (!outcome.ok) {
			setError(outcome.message);
			setPrompts(null);
			return;
		}
		setPrompts(outcome.prompts);
	}, []);

	useEffect(() => {
		void load(engine);
	}, [engine, load]);

	return (
		<section className="panel">
			<header>
				<h2>Prompts</h2>
				<span className="spacer" />
				<label className="field" style={{ margin: 0 }}>
					<span>engine</span>
					<select value={engine} onChange={(event) => setEngine(event.target.value as EngineName)}>
						<option value="iris">iris</option>
						<option value="helios">helios</option>
					</select>
				</label>
				<button type="button" onClick={() => void load(engine)} disabled={loading}>
					{loading ? 'loading…' : 'reload'}
				</button>
			</header>

			<div className="panel-body">
				<p className="hint">
					Stored in <code>{engine}-d1</code>, read by the engine on every request. A save is live on the next
					request with no deploy — there is no staging step between this box and a billed model call.
				</p>

				{error && <p className="empty">{error}</p>}

				{prompts?.map((prompt) => (
					<SlotEditor key={prompt.slot} engine={engine} prompt={prompt} onSaved={() => void load(engine)} />
				))}

				{prompts?.length === 0 && <p className="empty">This engine has no editable slots.</p>}
			</div>
		</section>
	);
}

/**
 * One slot.
 *
 * The draft is local until Save. `dirty` compares against what was loaded rather
 * than tracking a boolean, so typing a change and undoing it correctly reads as
 * unchanged and the button goes quiet again.
 */
function SlotEditor({
	engine,
	prompt,
	onSaved,
}: {
	engine: EngineName;
	prompt: PromptView;
	onSaved: () => void;
}) {
	const stored = prompt.promptText ?? '';
	const [draft, setDraft] = useState(stored);
	const [saving, setSaving] = useState(false);
	const [note, setNote] = useState<string | null>(null);

	// A reload replaces the row underneath this component; the draft follows it
	// unless the person has unsaved edits, which are never silently discarded.
	useEffect(() => {
		setDraft(stored);
	}, [stored]);

	const dirty = draft !== stored;
	const tooShort = draft.trim().length > 0 && draft.trim().length < 20;

	async function save() {
		setSaving(true);
		setNote(null);
		const outcome = await savePrompt(engine, prompt.slot, draft);
		setSaving(false);

		if (!outcome.ok) {
			setNote(`not saved — ${outcome.message}`);
			return;
		}
		setNote(`saved ${outcome.updatedAt ?? ''} — live on the next request`);
		onSaved();
	}

	return (
		<div className="section">
			<h3 className="section-title">
				<code>{prompt.slot}</code>
				{!LIVE_SLOTS.has(prompt.slot) && <span className="chip"> not read yet</span>}
			</h3>
			<p className="section-note">{SLOT_LABELS[prompt.slot] ?? 'No description for this slot.'}</p>

			<textarea
				value={draft}
				spellCheck={false}
				onChange={(event) => setDraft(event.target.value)}
				rows={16}
				style={{ width: '100%', fontFamily: 'inherit', fontSize: '0.85rem' }}
				placeholder={
					prompt.promptText === null
						? 'Nothing stored for this slot yet — the engine is using its built-in prompt. Saving here takes over.'
						: undefined
				}
			/>

			<div className="banner-row">
				<span className="hint">
					{draft.length} chars
					{prompt.updatedAt ? ` · stored ${prompt.updatedAt}` : ' · nothing stored yet'}
					{dirty ? ' · unsaved changes' : ''}
				</span>
				<span className="spacer" />
				<button type="button" onClick={() => void save()} disabled={!dirty || saving || tooShort}>
					{saving ? 'saving…' : 'Save'}
				</button>
			</div>

			{tooShort && (
				<p className="section-note missing">
					A prompt must be at least 20 characters. The engine ignores anything shorter and falls back to its
					built-in prompt, so a shorter save would look like it worked and change nothing.
				</p>
			)}
			{note && <p className="section-note">{note}</p>}
		</div>
	);
}
