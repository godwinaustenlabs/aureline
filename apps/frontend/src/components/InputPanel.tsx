import { useEffect, useState } from 'react';
import { GENERATE_COST_USD } from '../api/client';
import { usd } from '../domain/format';
import { newDesignSessionId } from '../domain/designSession';
import { DEFAULT_SESSION, effectiveSession, normaliseSessionId, randomSessionId, type RememberedSession } from '../state/sessions';

interface Props {
	concept: string;
	onConcept: (value: string) => void;
	sessionField: string;
	onSessionField: (value: string) => void;
	designSessionField: string;
	onDesignSessionField: (value: string) => void;
	sessions: readonly RememberedSession[];
	onForgetSession: (id: string) => void;
	baseUrl: string;
	onBaseUrl: (value: string) => void;
	inFlight: boolean;
	validationError: string | null;
	onGenerate: () => void;
	onPing: () => void;
	connection: { ok: boolean; message: string } | null;
}

export function InputPanel({
	concept,
	onConcept,
	sessionField,
	onSessionField,
	designSessionField,
	onDesignSessionField,
	sessions,
	onForgetSession,
	baseUrl,
	onBaseUrl,
	inFlight,
	validationError,
	onGenerate,
	onPing,
	connection,
}: Props) {
	const normalised = normaliseSessionId(sessionField);
	const target = effectiveSession(sessionField);

	return (
		<section className="panel">
			<header>
				<h2>Input</h2>
			</header>
			<div className="panel-body">
				<div className="field">
					<label htmlFor="concept">Concept</label>
					<textarea
						id="concept"
						value={concept}
						maxLength={1000}
						placeholder="art deco paisley with fine linework"
						onChange={(event) => onConcept(event.target.value)}
					/>
					<span className="hint">
						{concept.trim().length} / 1000 characters, trimmed. Validated here with <code>HeliosRequestSchema</code> before anything is
						sent, so a 400 never costs a round trip.
					</span>
					{validationError && <span className="hint error">{validationError}</span>}
				</div>

				<div className="field">
					<label htmlFor="design-session">Design session id</label>
					<div className="row">
						<input
							id="design-session"
							type="text"
							value={designSessionField}
							onChange={(event) => onDesignSessionField(event.target.value)}
						/>
						<button
							className="small"
							onClick={() => onDesignSessionField(newDesignSessionId())}
							title="Start a different design"
						>
							New
						</button>
					</div>
					<span className="hint">
						The design, not the run and not the Durable Object. Required, and carried unchanged into Iris and
						Atlas — it is what ties one design&apos;s pattern, colouring and placement together. Keep it to run
						the same design again; press New to start a different one.
					</span>
				</div>

				<div className="field">
					<label htmlFor="session">Session id</label>
					<div className="row">
						<input
							id="session"
							type="text"
							value={sessionField}
							placeholder={DEFAULT_SESSION}
							onChange={(event) => onSessionField(event.target.value)}
						/>
						<button className="small" onClick={() => onSessionField(randomSessionId())} title="Generate a fresh readable id">
							Randomise
						</button>
					</div>

					{sessions.length > 0 && (
						<div className="row">
							<select
								value={sessions.some((session) => session.id === normalised) ? normalised : ''}
								onChange={(event) => event.target.value && onSessionField(event.target.value)}
								aria-label="Sessions this browser has used"
							>
								<option value="">Sessions this browser has used…</option>
								{sessions.map((session) => (
									<option key={session.id} value={session.id}>
										{session.id}
									</option>
								))}
							</select>
							{normalised && sessions.some((session) => session.id === normalised) && (
								<button className="small danger" onClick={() => onForgetSession(normalised)} title="Remove from this list only">
									Forget
								</button>
							)}
						</div>
					)}

					<span className="hint">
						Sending as <code>{target}</code>. Trimmed and lowercased, because the worker hashes the name exactly and{' '}
						<code>Test</code> would otherwise be a different Durable Object from <code>test</code>.
					</span>

					{!normalised && (
						<span className="hint warn">
							An empty id is not "no session". The worker falls back to a shared Durable Object literally named{' '}
							<code>default</code>, which is where every run made without an id has ever gone — a real store with a real history.
						</span>
					)}

					<span className="hint">
						The id picks which Durable Object serves the request, so it decides which runs the history shows and which runs can be
						resumed. This list is <code>localStorage</code> only: Durable Objects cannot be enumerated and no run row records its
						session, so an id this browser never used has to be typed.
					</span>
				</div>

				<ReferenceImage />

				<div className="field">
					<label htmlFor="base-url">API base URL</label>
					<div className="row">
						<input id="base-url" type="text" value={baseUrl} onChange={(event) => onBaseUrl(event.target.value)} />
						<button className="small" onClick={onPing} title="GET / — free">
							Check
						</button>
					</div>
					{connection && (
						<span className={connection.ok ? 'hint' : 'hint error'}>
							{connection.ok ? `reachable — "${connection.message}"` : connection.message}
						</span>
					)}
				</div>

				<button className="primary" disabled={inFlight} onClick={onGenerate}>
					{inFlight ? 'Running…' : `Generate — about ${usd(GENERATE_COST_USD)}`}
				</button>
			</div>
		</section>
	);
}

/**
 * In scope purely so the shape exists for a later sprint.
 *
 * The file is held **here**, in this component, and is never lifted into the
 * app's state or passed to anything that builds a request — so it is not merely
 * unsent, it has nowhere to be sent from. It is previewed locally and discarded.
 *
 * The label is the important half. Every person testing this page will otherwise
 * upload something, see it have no effect, and report it as a bug.
 */
function ReferenceImage() {
	const [preview, setPreview] = useState<string | null>(null);
	const [name, setName] = useState<string | null>(null);

	// An object URL is held by the document until it is revoked. This cleanup runs
	// both when `preview` changes and when the component unmounts, so every URL
	// created below is released exactly once.
	useEffect(() => {
		return () => {
			if (preview) URL.revokeObjectURL(preview);
		};
	}, [preview]);

	return (
		<div className="field">
			<label htmlFor="reference">Reference image</label>
			<div className="reference">
				<span className="banner">Not sent. Discarded in the browser.</span>
				<span className="hint">
					The planner does not accept a reference image yet — nothing in the pipeline reads one. This field exists so the shape is here
					for a later sprint. The file never enters a request body.
				</span>
				<input
					id="reference"
					type="file"
					accept="image/*"
					onChange={(event) => {
						const file = event.target.files?.[0] ?? null;
						setPreview(file ? URL.createObjectURL(file) : null);
						setName(file?.name ?? null);
					}}
				/>
				{preview && <img src={preview} alt={`Local preview of ${name ?? 'the selected file'} — not sent to the worker`} />}
				{name && <span className="hint">{name} — previewed locally, discarded on submit.</span>}
			</div>
		</div>
	);
}
