import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GENERATE_COST_USD, RESUME_COST_USD, generate, listRuns, ping, resume } from './api/client';
import type { RunRow } from './api/runs';
import type { CallOutcome } from './domain/outcome';
import { usd } from './domain/format';
import { briefHistory, describeBriefHistory, groupRows } from './domain/runView';
import { buildScratchpad } from './domain/scratchpad';
import { validateGenerate } from './domain/validate';
import { newDesignSessionId } from './domain/designSession';
import { imageUrlFor, r2KeyFromUrl } from './domain/imageUrl';
import { validateIrisGenerate } from './domain/validate';
import { generateIris, resumeIris, pingIris, IRIS_GENERATE_COST_USD, IRIS_RESUME_COST_USD } from './api/iris';
import type { IrisCallOutcome } from './domain/irisOutcome';
import { IrisPanel } from './components/IrisPanel';
import { effectiveSession, forget, loadSessions, normaliseSessionId, remember, saveSessions, type RememberedSession } from './state/sessions';
import { DEFAULT_BASE_URL, loadBaseUrl, saveBaseUrl, loadIrisBaseUrl, saveIrisBaseUrl } from './state/settings';
import { NO_SPEND, recordCall } from './state/spend';
import { ConfirmSpend, type SpendRequest } from './components/ConfirmSpend';
import { ImageOutput } from './components/ImageOutput';
import { InputPanel } from './components/InputPanel';
import { RunHistory } from './components/RunHistory';
import { Scratchpad } from './components/Scratchpad';
import { PromptsPanel } from './components/PromptsPanel';

/**
 * The playground.
 *
 * Three rules hold across everything below, and each one is a shipped bug if it
 * slips:
 *
 * 1. **`status` decides success, never the HTTP code.** That is settled once, in
 *    `api/client.ts`, which hands back a three-way `CallOutcome` — so nothing
 *    here ever sees a raw `Response` to be tempted by.
 * 2. **Nothing bills without a click.** Every `POST` is reached from a confirm
 *    dialog inside an event handler. No effect, no interval, no retry.
 * 3. **`GET /runs` is free and read-only**, so it is the only call an effect
 *    makes and the only one that fires on a session switch.
 */
export function App() {
	/**
	 * Which screen is showing.
	 *
	 * Not a router: this page has no URLs of its own and one piece of state is
	 * the whole of it. The prompt editor is a separate screen rather than another
	 * panel because it edits what the engine *will* do, while everything else on
	 * the run screen reports what it *did* — mixing the two invites editing a
	 * prompt while reading a run that the old one produced.
	 */
	const [view, setView] = useState<'run' | 'iris' | 'prompts'>('run');
	const [baseUrl, setBaseUrl] = useState(loadBaseUrl);
	const [concept, setConcept] = useState('');
	const [sessionField, setSessionField] = useState('');
	/**
	 * The design this run belongs to, seeded once per page load.
	 *
	 * Held rather than minted per click, deliberately: two generates with the same
	 * value are two attempts at one design, which is what makes them comparable in
	 * Iris and Atlas later. Pressing New starts a different design.
	 */
	const [designSessionField, setDesignSessionField] = useState(newDesignSessionId);

	/**
	 * Iris's whole screen state, held here rather than inside `IrisPanel`.
	 *
	 * The panels unmount when you switch tabs, so state owned by a panel would be
	 * discarded the moment you looked at anything else — which is exactly what
	 * must not happen after a run that cost money. Lifting it means switching
	 * Helios → Iris → Helios shows both results still sitting there.
	 */
	const [irisBaseUrl, setIrisBaseUrl] = useState(loadIrisBaseUrl);
	const [irisConcept, setIrisConcept] = useState('');
	const [irisMotifRef, setIrisMotifRef] = useState('');
	const [irisSessionField, setIrisSessionField] = useState('');
	const [irisDesignSessionId, setIrisDesignSessionId] = useState('');
	const [irisOutcome, setIrisOutcome] = useState<IrisCallOutcome | null>(null);
	/**
	 * Iris's own run history, from Iris's own `GET /runs`.
	 *
	 * A separate list from `rows`, not a filtered view of it: the two engines are
	 * two Workers with two Durable Object namespaces and two `*_runs` tables. The
	 * same session name in both is not the same object, so merging them would
	 * group runs that have nothing to do with each other.
	 */
	const [irisRows, setIrisRows] = useState<RunRow[]>([]);
	const [irisRowsError, setIrisRowsError] = useState<string | null>(null);
	const [irisRowsLoading, setIrisRowsLoading] = useState(false);
	const [irisSelectedId, setIrisSelectedId] = useState<string | null>(null);
	const [irisError, setIrisError] = useState<string | null>(null);
	const [irisConnection, setIrisConnection] = useState<{ ok: boolean; message: string } | null>(null);
	const [irisInFlight, setIrisInFlight] = useState<{ startedAt: number } | null>(null);
	const [irisElapsedMs, setIrisElapsedMs] = useState(0);
	const [handoffNote, setHandoffNote] = useState<string | null>(null);
	const [sessions, setSessions] = useState<RememberedSession[]>(loadSessions);

	const [validationError, setValidationError] = useState<string | null>(null);
	// The reference image lives here rather than in `InputPanel`, because the
	// request is built here. Holding it in the panel is what previously made it
	// impossible to send.
	const [referenceImage, setReferenceImage] = useState<File | null>(null);
	// Iris's own, kept separate from Helios's. The two panels are different runs
	// against different workers, and sharing one file between them would attach a
	// picture to a run whose panel never showed it.
	const [irisReferenceImage, setIrisReferenceImage] = useState<File | null>(null);
	const [connection, setConnection] = useState<{ ok: boolean; message: string } | null>(null);

	const [inFlight, setInFlight] = useState<{ startedAt: number } | null>(null);
	const [elapsedMs, setElapsedMs] = useState(0);

	const [outcome, setOutcome] = useState<CallOutcome | null>(null);
	/** Which Durable Object produced the result on screen. Resume is session-bound,
	 *  so this has to be remembered rather than assumed to be the current field. */
	const [outcomeSession, setOutcomeSession] = useState<string | null>(null);
	const [wallClockMs, setWallClockMs] = useState<number | null>(null);

	const [rows, setRows] = useState<RunRow[]>([]);
	const [rowsError, setRowsError] = useState<string | null>(null);
	const [rowsLoading, setRowsLoading] = useState(false);

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [spend, setSpend] = useState(NO_SPEND);
	const [spendRequest, setSpendRequest] = useState<SpendRequest | null>(null);

	/** The Durable Object the next request will reach. */
	const target = effectiveSession(sessionField);

	// Read inside callbacks so that editing the URL does not re-fire the history
	// effect on every keystroke. The Check button refreshes on demand instead.
	const baseUrlRef = useRef(baseUrl);
	baseUrlRef.current = baseUrl;

	useEffect(() => saveBaseUrl(baseUrl), [baseUrl]);
	useEffect(() => saveIrisBaseUrl(irisBaseUrl), [irisBaseUrl]);
	useEffect(() => saveSessions(sessions), [sessions]);

	/**
	 * The wall clock behind the spinner. A `setInterval` over a local number — it
	 * makes no request and is not the polling loop decision 3 forbids.
	 */
	useEffect(() => {
		if (!inFlight) return;
		setElapsedMs(0);
		const timer = setInterval(() => setElapsedMs(Date.now() - inFlight.startedAt), 100);
		return () => clearInterval(timer);
	}, [inFlight]);

	/** The same clock for Iris. Its own, because the two can never be in flight
	 *  together and sharing one would make a stale reading look like a live one. */
	useEffect(() => {
		if (!irisInFlight) return;
		setIrisElapsedMs(0);
		const timer = setInterval(() => setIrisElapsedMs(Date.now() - irisInFlight.startedAt), 100);
		return () => clearInterval(timer);
	}, [irisInFlight]);

	const refreshRuns = useCallback(async (session: string): Promise<RunRow[] | null> => {
		setRowsLoading(true);
		const outcome = await listRuns(baseUrlRef.current, session);
		setRowsLoading(false);

		if (!outcome.ok) {
			setRows([]);
			setRowsError(outcome.message);
			return null;
		}

		setRows(outcome.rows);
		setRowsError(null);
		return outcome.rows;
	}, []);

	// The session id is the whole mechanism: switching it means a different
	// Durable Object with a different history, so the table reloads from it.
	// Free and read-only, which is why it is allowed to be an effect at all.
	useEffect(() => {
		void refreshRuns(target);
	}, [target, refreshRuns]);

	const groups = useMemo(() => groupRows(rows), [rows]);
	const selected = groups.find((group) => group.pipelineId === selectedId) ?? null;

	/**
	 * The same read against Iris. `listRuns` already takes a base URL, so it is
	 * engine-agnostic as it stands — Iris serves the identical `{ runs: [...] }`
	 * envelope from the identical route, and `iris_runs` is `helios_runs` plus
	 * `motif_ref`. Nothing here needed generalising beyond pointing it elsewhere.
	 */
	const refreshIrisRuns = useCallback(async (session: string, baseUrl: string): Promise<RunRow[] | null> => {
		setIrisRowsLoading(true);
		const outcome = await listRuns(baseUrl, session);
		setIrisRowsLoading(false);

		if (!outcome.ok) {
			setIrisRows([]);
			setIrisRowsError(outcome.message);
			return null;
		}

		setIrisRows(outcome.rows);
		setIrisRowsError(null);
		return outcome.rows;
	}, []);

	const irisTarget = effectiveSession(irisSessionField);
	const irisGroups = useMemo(() => groupRows(irisRows), [irisRows]);
	const irisSelected = irisGroups.find((group) => group.pipelineId === irisSelectedId) ?? null;

	/**
	 * Only loads while the Iris tab is showing. `GET /runs` is free and read-only,
	 * so this is allowed to be an effect at all — but there is no reason to keep
	 * polling a second engine on every session change while nobody is looking at
	 * it.
	 */
	useEffect(() => {
		if (view !== 'iris') return;
		void refreshIrisRuns(irisTarget, irisBaseUrl);
	}, [view, irisTarget, irisBaseUrl, refreshIrisRuns]);

	/** The coloured image for an Iris run picked out of its history. */
	const irisHistoryImage = useMemo(() => {
		if (!irisSelected) return null;
		if (irisOutcome?.kind === 'run' && irisOutcome.result.pipeline_id === irisSelected.pipelineId) return null;

		const key = irisSelected.image?.imageR2Key;
		if (!key) return null;

		return { url: imageUrlFor(irisBaseUrl, key), pipelineId: irisSelected.pipelineId };
	}, [irisSelected, irisOutcome, irisBaseUrl]);

	/** The result belongs in the scratchpad only when it is the run being shown —
	 *  clicking a history row swaps the rows out from under it. Selecting a run
	 *  costs nothing: its rows are already in `groups` from the last `GET /runs`. */
	const scratchResult = outcome?.kind === 'run' && outcome.result.pipeline_id === selectedId ? outcome.result : null;

	/**
	 * The image for a run picked out of the history.
	 *
	 * Null when the live outcome is already showing that same run, so a fresh
	 * generate keeps its own panel — the raw response body and the resume button
	 * belong to it, and a history view has neither.
	 */
	const historyImage = useMemo(() => {
		if (!selected || selected.pipelineId === scratchResult?.pipeline_id) return null;

		const key = selected.image?.imageR2Key;
		// An explicit check, not `?.` falling through: a selected run with no image
		// row, or one that failed before saving, genuinely has nothing to show.
		if (!key) return null;

		return { url: imageUrlFor(baseUrl, key), pipelineId: selected.pipelineId };
	}, [selected, scratchResult, baseUrl]);

	const sections = useMemo(() => {
		if (!selectedId) return null;

		return buildScratchpad({
			result: scratchResult,
			group: selected,
			wallClockMs: scratchResult ? wallClockMs : null,
			rowsUnavailableReason: rowsUnavailableReason(rowsError, Boolean(selectedId), Boolean(selected)),
		});
	}, [selectedId, selected, scratchResult, wallClockMs, rowsError]);

	async function runBilledCall(session: string, call: () => Promise<CallOutcome>) {
		setInFlight({ startedAt: Date.now() });
		setOutcome(null);
		setWallClockMs(null);

		const startedAt = performance.now();
		const result = await call();
		const wallClock = performance.now() - startedAt;

		setOutcome(result);
		setOutcomeSession(session);
		setWallClockMs(wallClock);
		setSessions((current) => remember(current, normaliseSessionId(sessionField)));

		if (result.kind === 'run') {
			// Only a run wrote anything. A 409 refusal and a transport error both
			// left the store exactly as it was and billed nothing.
			setSelectedId(result.result.pipeline_id);

			const refreshed = await refreshRuns(session);
			const group = refreshed ? (groupRows(refreshed).find((it) => it.pipelineId === result.result.pipeline_id) ?? null) : null;

			// The real total from the rows, not the image-only figure the response
			// carries. Null when the rows could not be read, which marks the tally
			// approximate rather than under-reporting it.
			setSpend((current) => recordCall(current, group?.totalCostUsd ?? null));

			// The handoff to Iris. A completed pattern is the only input Iris has,
			// so the moment one exists this fills its two carried fields and moves
			// there — the alternative is copying a UUID and an R2 key by hand.
			//
			// The key comes from the **row** when the rows could be read, and from
			// the response URL only as a fallback. The row stores what was actually
			// written; the URL has to be taken apart to get back to it.
			if (result.result.status === 'completed') {
				const key = group?.image?.imageR2Key ?? (result.result.image_url ? r2KeyFromUrl(result.result.image_url) : null);

				// Explicit, not `?.` falling through: a completed run with no
				// recoverable key must not silently land on the Iris tab with an
				// empty motif ref, where the next click is a validation error the
				// person did not cause.
				if (key) {
					setIrisMotifRef(key);
					setIrisDesignSessionId(result.result.design_session_id);
					setIrisOutcome(null);
					setIrisError(null);
					setHandoffNote(
						`Carried from Helios run ${result.result.pipeline_id}. The motif ref is that run's stored R2 key and the design id is its own — leave both alone and this colouring stays part of the same design.`,
					);
					setView('iris');
				}
			}
		}

		setInFlight(null);
	}

	/**
	 * Iris's generate. A separate path from `runBilledCall` on purpose: it talks
	 * to a different worker, returns a different body, and has no run history or
	 * resume behind it — folding the two together would mean branching on engine
	 * inside every step of one function.
	 */
	/**
	 * Re-runs the image half of an existing Iris invocation from the params
	 * already on disk. The planner is never called, so the colours come back
	 * identical — this buys another attempt at the image, not a different plan.
	 */
	function requestIrisResume(pipelineId: string) {
		const sessionId = normaliseSessionId(irisSessionField);
		const spentSoFar = describeBriefHistory(briefHistory(irisGroups, pipelineId));

		askToSpend({
			title: 'Resume this Iris run',
			costUsd: IRIS_RESUME_COST_USD,
			detail: `Runs the image half again from the stored params, against "${irisTarget}". The planner is never called, so the colours come back identical. This is additional spend on a run that was already paid for, and it produces a new pipeline_id.${spentSoFar ? ` Note: ${spentSoFar}.` : ''}`,
			confirmLabel: 'Spend it again',
			run: async () => {
				setIrisInFlight({ startedAt: Date.now() });
				setIrisOutcome(null);

				const outcome = await resumeIris(irisBaseUrl, {
					pipeline_id: pipelineId,
					...(sessionId ? { session_id: sessionId } : {}),
				});

				setIrisOutcome(outcome);
				setIrisInFlight(null);

				if (outcome.kind === 'run') {
					setIrisSelectedId(outcome.result.pipeline_id);
					void refreshIrisRuns(irisTarget, irisBaseUrl);
					setSpend((current) => recordCall(current, null));
				}
			},
		});
	}

	function requestIrisGenerate() {
		const validated = validateIrisGenerate({
			concept: irisConcept,
			motifRef: irisMotifRef.trim(),
			designSessionId: irisDesignSessionId.trim(),
			sessionId: normaliseSessionId(irisSessionField),
		});
		if (!validated.ok) {
			setIrisError(validated.message);
			return;
		}
		setIrisError(null);

		askToSpend({
			title: 'Colour this motif',
			costUsd: IRIS_GENERATE_COST_USD,
			detail: `One planner call plus one image-to-image call against Iris, colouring "${irisMotifRef.trim()}". The pattern itself is not regenerated.`,
			confirmLabel: 'Spend it',
			run: async () => {
				setIrisInFlight({ startedAt: Date.now() });
				setIrisOutcome(null);

				const outcome = await generateIris(irisBaseUrl, validated.request, irisReferenceImage);

				setIrisOutcome(outcome);
				setIrisInFlight(null);

				// Only a run wrote anything. A 409 and a transport failure both left
				// the store exactly as it was.
				if (outcome.kind === 'run') {
					setIrisSelectedId(outcome.result.pipeline_id);
					void refreshIrisRuns(irisTarget, irisBaseUrl);
				}
				// Iris reports the image cost alone and there is no rows read to
				// correct it with, so the tally is marked approximate rather than
				// claiming a total it does not have.
				if (outcome.kind === 'run') setSpend((current) => recordCall(current, null));
			},
		});
	}

	function requestGenerate() {
		const validated = validateGenerate({
			concept,
			designSessionId: designSessionField.trim(),
			sessionId: normaliseSessionId(sessionField),
		});
		if (!validated.ok) {
			setValidationError(validated.message);
			return;
		}
		setValidationError(null);

		askToSpend({
			title: 'Generate a pattern',
			costUsd: GENERATE_COST_USD,
			detail: `One planner call plus one image call, against the Durable Object named "${target}". About $0.001 of it is the planner and about $0.0019 the image.`,
			confirmLabel: 'Spend it',
			// The file is read from state at call time rather than captured into
			// `validated`: the schema validates the text fields, and a `File` is not
			// the `{ bytes, contentType }` shape the contract carries — the engine
			// builds that from the form part it receives.
			run: () => runBilledCall(target, () => generate(baseUrlRef.current, validated.request, referenceImage)),
		});
	}

	function requestResume(pipelineId: string) {
		const sessionId = normaliseSessionId(sessionField);

		// What this brief has already bought. A run whose own image failed stays
		// resumable even after a resume of it succeeded, so without this the dialog
		// would read identically whether it is the first attempt or the third.
		const spentSoFar = describeBriefHistory(briefHistory(groups, pipelineId));

		askToSpend({
			title: 'Resume this run',
			costUsd: RESUME_COST_USD,
			detail: `Runs the image half again from the stored params, against "${target}". The planner is never called, so the params come back identical. This is additional spend on a run that was already paid for, and it produces a new pipeline_id — the original is left exactly as it was.${spentSoFar ? ` Note: ${spentSoFar}.` : ''}`,
			confirmLabel: 'Spend it again',
			run: () =>
				runBilledCall(target, () =>
					resume(baseUrlRef.current, { pipeline_id: pipelineId, ...(sessionId ? { session_id: sessionId } : {}) }),
				),
		});
	}

	function askToSpend({ run, ...request }: Omit<SpendRequest, 'onConfirm'> & { run: () => Promise<void> }) {
		setSpendRequest({
			...request,
			onConfirm: () => {
				setSpendRequest(null);
				void run();
			},
		});
	}

	async function checkConnection() {
		setConnection(await ping(baseUrlRef.current));
		void refreshRuns(target);
	}

	// Resume is session-bound: a pipeline_id from one session 409s in another. If
	// the field has moved since this result arrived, its button no longer applies.
	const sessionMoved = outcome?.kind === 'run' && outcomeSession !== null && outcomeSession !== target;

	const resultGroup = outcome?.kind === 'run' ? (groups.find((group) => group.pipelineId === outcome.result.pipeline_id) ?? null) : null;
	const resultResumable =
		outcome?.kind === 'run' &&
		(resultGroup ? resultGroup.resumable : outcome.result.status === 'failed' && outcome.result.params !== null);

	return (
		<div className="app">
			<div className="masthead">
				<h1>Helios Playground</h1>
				<span className="tagline">internal debug console — every generate spends real money</span>
				<span className="tally">
					{spend.calls} billed {spend.calls === 1 ? 'call' : 'calls'} · {spend.approximate ? 'at least ' : ''}
					{usd(spend.usd)} since page load
				</span>
			</div>

			{/* `role="tablist"` and not a set of disabled buttons: a disabled control
			    reads as unavailable, and the current tab is the opposite of that. */}
			<nav className="viewnav" role="tablist" aria-label="Screen">
				<button
					type="button"
					role="tab"
					className={view === 'run' ? 'tab current' : 'tab'}
					aria-selected={view === 'run'}
					onClick={() => setView('run')}
				>
					Run
				</button>
				<button
					type="button"
					role="tab"
					className={view === 'iris' ? 'tab current' : 'tab'}
					aria-selected={view === 'iris'}
					onClick={() => setView('iris')}
				>
					Iris
				</button>
				<button
					type="button"
					role="tab"
					className={view === 'prompts' ? 'tab current' : 'tab'}
					aria-selected={view === 'prompts'}
					onClick={() => setView('prompts')}
				>
					Prompts
				</button>
				<span className="spacer" />
				<span className="hint">
					{view === 'prompts'
						? 'editing what the engines send — free, and live on their next request'
						: view === 'iris'
							? 'colouring a pattern Helios already made — every run spends real money'
							: 'generating a black-and-white pattern — every run spends real money'}
				</span>
			</nav>

			{view === 'prompts' ? (
				// Full width, not a column: these are 6,000-character prompts and the
				// left grid track is 410px.
				<div className="column wide">
					<PromptsPanel />
				</div>
			) : view === 'iris' ? (
				<IrisPanel
					concept={irisConcept}
					onConcept={setIrisConcept}
					motifRef={irisMotifRef}
					onMotifRef={setIrisMotifRef}
					designSessionId={irisDesignSessionId}
					onDesignSessionId={setIrisDesignSessionId}
					sessionField={irisSessionField}
					onSessionField={setIrisSessionField}
					baseUrl={irisBaseUrl}
					onBaseUrl={setIrisBaseUrl}
					inFlight={irisInFlight !== null}
					elapsedMs={irisElapsedMs}
					validationError={irisError}
					onGenerate={requestIrisGenerate}
					onPing={() => void pingIris(irisBaseUrl).then(setIrisConnection)}
					connection={irisConnection}
					referenceImage={irisReferenceImage}
					onReferenceImage={setIrisReferenceImage}
					outcome={irisOutcome}
					historyImage={irisHistoryImage}
					groups={irisGroups}
					session={irisTarget}
					rowsLoading={irisRowsLoading}
					rowsError={irisRowsError}
					selectedId={irisSelectedId}
					onSelect={setIrisSelectedId}
					onResume={requestIrisResume}
					onRefreshRuns={() => void refreshIrisRuns(irisTarget, irisBaseUrl)}
					handoffNote={handoffNote}
				/>
			) : (
			<>
			<div className="column">
				<InputPanel
					concept={concept}
					onConcept={setConcept}
					sessionField={sessionField}
					onSessionField={setSessionField}
					designSessionField={designSessionField}
					onDesignSessionField={setDesignSessionField}
					sessions={sessions}
					onForgetSession={(id) => setSessions((current) => forget(current, id))}
					baseUrl={baseUrl}
					onBaseUrl={setBaseUrl}
					inFlight={inFlight !== null}
					validationError={validationError}
					onGenerate={requestGenerate}
					onPing={() => void checkConnection()}
					connection={connection}
					referenceImage={referenceImage}
					onReferenceImage={setReferenceImage}
				/>
				<p className="hint">
					Default base URL is <code>{DEFAULT_BASE_URL}</code>. <code>GET /runs</code>, <code>GET /</code> and the image bytes are all
					free; only <code>/generate</code> and <code>/resume</code> cost anything.
				</p>
			</div>

			<div className="column">
				<ImageOutput
					outcome={outcome}
					waitingMs={inFlight ? elapsedMs : null}
					onResume={
						resultResumable && !sessionMoved && !inFlight && outcome?.kind === 'run'
							? () => requestResume(outcome.result.pipeline_id)
							: null
					}
					resumeNote={outcome?.kind === 'run' ? describeBriefHistory(briefHistory(groups, outcome.result.pipeline_id)) : null}
					historyImage={historyImage}
					resumeBlockedReason={
						sessionMoved
							? `This run was made in session "${outcomeSession}" and the field now reads "${target}". Resume is session-bound — a pipeline_id from one session is refused in another with "no run with that id in this session". Switch back to resume it.`
							: null
					}
				/>

				<Scratchpad sections={sections} waitingMs={inFlight ? elapsedMs : null} />

				<RunHistory
					groups={groups}
					session={target}
					loading={rowsLoading}
					error={rowsError}
					selectedId={selectedId}
					onSelect={setSelectedId}
					onResume={requestResume}
					onRefresh={() => void refreshRuns(target)}
					busy={inFlight !== null}
				/>
			</div>
			</>
			)}

			{spendRequest && <ConfirmSpend request={spendRequest} onCancel={() => setSpendRequest(null)} />}
		</div>
	);
}

/**
 * Why the scratchpad has no rows to work from, when it has none.
 *
 * The pruning case is worth naming rather than leaving as an empty panel: the
 * Durable Object keeps only the newest `retention_limit` completed runs and
 * prunes on every invocation, so an older successful run genuinely is gone from
 * the only store this page can read.
 */
function rowsUnavailableReason(rowsError: string | null, hasSelection: boolean, hasRows: boolean): string | undefined {
	if (rowsError) return `GET /runs failed, so everything below is from the response alone: ${rowsError}`;
	if (hasSelection && !hasRows) {
		return 'The Durable Object holds no rows for this run. Completed runs beyond retention_limit are pruned on every invocation — the run is still in D1 permanently, but there is no route that lists D1.';
	}
	return undefined;
}
