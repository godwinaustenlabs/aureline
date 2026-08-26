import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generate, listRuns, ping, resume } from './api/client';
import type { RunRow } from './api/runs';
import type { CallOutcome } from './domain/outcome';
import { usd } from './domain/format';
import { briefHistory, describeBriefHistory, groupRows } from './domain/runView';
import { buildScratchpad } from './domain/scratchpad';
import { validateAtlasGenerate, validateHeliosGenerate, validateIrisGenerate } from './domain/validate';
import { ENGINE_SPECS, type Engine } from './domain/engines';
import type { EngineFieldValues } from './components/EngineFields';
import { effectiveSession, forget, loadSessions, normaliseSessionId, remember, saveSessions, type RememberedSession } from './state/sessions';
import { loadBaseUrl, loadEngine, saveBaseUrl, saveEngine } from './state/settings';
import { NO_SPEND, recordCall } from './state/spend';
import { ConfirmSpend, type SpendRequest } from './components/ConfirmSpend';
import { ImageOutput } from './components/ImageOutput';
import { InputPanel } from './components/InputPanel';
import { RunHistory } from './components/RunHistory';
import { Scratchpad } from './components/Scratchpad';

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
	const [engine, setEngine] = useState<Engine>(loadEngine);
	const [baseUrl, setBaseUrl] = useState(() => loadBaseUrl(loadEngine()));
	const [concept, setConcept] = useState('');
	const [fields, setFields] = useState<EngineFieldValues>({
		concept: '',
		motifRef: '',
		patternRef: '',
		garmentRef: '',
		designSessionId: '',
		garmentType: 'tshirt',
		regions: ['back'],
		coverage: 'allover',
		patternScale: 'medium',
	});
	const [sessionField, setSessionField] = useState('');
	const [sessions, setSessions] = useState<RememberedSession[]>(loadSessions);

	const [validationError, setValidationError] = useState<string | null>(null);
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

	useEffect(() => saveBaseUrl(engine, baseUrl), [engine, baseUrl]);
	useEffect(() => saveEngine(engine), [engine]);

	/**
	 * Switching engines swaps in that engine's own base URL.
	 *
	 * Sharing one URL across all three is the mistake that costs a wrong-engine
	 * call: you switch to Iris, the field still holds Helios's URL, you click
	 * generate, and Helios receives a body with `motif_ref` in it. Zod strips
	 * unknown keys, so it does not error — it runs a normal Helios generate and
	 * bills you for it.
	 */
	function switchEngine(next: Engine) {
		setEngine(next);
		setBaseUrl(loadBaseUrl(next));
		setOutcome(null);
		setSelectedId(null);
		setValidationError(null);
	}
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
	}, [target, engine, refreshRuns]);

	const groups = useMemo(() => groupRows(engine, rows), [engine, rows]);
	const selected = groups.find((group) => group.runId === selectedId) ?? null;

	/** The result belongs in the scratchpad only when it is the run being shown —
	 *  clicking a history row swaps the rows out from under it. Selecting a run
	 *  costs nothing: its rows are already in `groups` from the last `GET /runs`. */
	const scratchResult = outcome?.kind === 'run' && outcome.runId === selectedId ? outcome.result : null;

	const sections = useMemo(() => {
		if (!selectedId) return null;

		return buildScratchpad({
			engine,
			runId: outcome?.kind === 'run' ? outcome.runId : null,
			result: scratchResult,
			group: selected,
			wallClockMs: scratchResult ? wallClockMs : null,
			rowsUnavailableReason: rowsUnavailableReason(rowsError, Boolean(selectedId), Boolean(selected)),
		});
	}, [engine, outcome, selectedId, selected, scratchResult, wallClockMs, rowsError]);

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
			setSelectedId(result.runId);

			const refreshed = await refreshRuns(session);
			const group = refreshed ? (groupRows(engine, refreshed).find((it) => it.runId === result.runId) ?? null) : null;

			// The real total from the rows, not the image-only figure the response
			// carries. Null when the rows could not be read, which marks the tally
			// approximate rather than under-reporting it.
			setSpend((current) => recordCall(current, group?.totalCostUsd ?? null));
		}

		setInFlight(null);
	}

	/** Builds this engine's request from its own schema, never a hand-copied rule. */
	function validateForEngine() {
		const session = normaliseSessionId(sessionField);

		if (engine === 'helios') return validateHeliosGenerate(concept, session);
		if (engine === 'iris') return validateIrisGenerate(concept, fields.motifRef, fields.designSessionId, session);

		return validateAtlasGenerate(
			fields.patternRef,
			fields.garmentRef,
			fields.designSessionId,
			fields.garmentType,
			fields.regions,
			fields.coverage,
			fields.patternScale,
			session,
		);
	}

	function requestGenerate() {
		const validated = validateForEngine();
		if (!validated.ok) {
			setValidationError(validated.message);
			return;
		}
		setValidationError(null);

		const spec = ENGINE_SPECS[engine];
		const request = validated.request;

		askToSpend({
			title: `Generate with ${spec.label}`,
			costUsd: spec.generateCostUsd,
			detail:
				spec.costIsEstimated ??
				`Against the Durable Object named "${target}". ${
					engine === 'iris'
						? 'One planner call plus one image-to-image call. The image half is about $0.017 — roughly six times a Helios run, so this is not the price you may be used to.'
						: 'One planner call plus one image call.'
				}`,
			confirmLabel: spec.generateCostUsd === 0 ? 'Run it' : 'Spend it',
			run: () => runBilledCall(target, () => generate(engine, baseUrlRef.current, request)),
		});
	}

	function requestResume(runId: string) {
		const sessionId = normaliseSessionId(sessionField);
		const spec = ENGINE_SPECS[engine];

		// What this brief has already bought. A run whose own image failed stays
		// resumable even after a resume of it succeeded, so without this the dialog
		// would read identically whether it is the first attempt or the third.
		const spentSoFar = describeBriefHistory(briefHistory(groups, runId));

		askToSpend({
			title: `Resume this ${spec.label} run`,
			costUsd: spec.resumeCostUsd,
			detail: `${
				spec.costIsEstimated ??
				`Runs the image call again from what is already stored, against "${target}". This is additional spend on a run that was already paid for.`
			} It produces a new run id — the original is left exactly as it was.${spentSoFar ? ` Note: ${spentSoFar}.` : ''}`,
			confirmLabel: spec.resumeCostUsd === 0 ? 'Run it again' : 'Spend it again',
			run: () => runBilledCall(target, () => resume(engine, baseUrlRef.current, runId, sessionId)),
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

	/**
	 * Carries the run on screen forward into this engine's input fields.
	 *
	 * There is no coordinator engine, so a person does this hand-off at every hop
	 * — twice per full chain. Offered only when the result on screen actually has
	 * an image to pass on.
	 */
	const upstreamImageUrl = outcome?.kind === 'run' ? (outcome.result.image_url ?? null) : null;
	const upstreamDesignId = outcome?.kind === 'run' ? (typeof outcome.result.design_session_id === 'string' ? outcome.result.design_session_id : null) : null;

	const copyFromUpstream =
		engine !== 'helios' && upstreamImageUrl
			? () =>
					setFields((current) => ({
						...current,
						...(engine === 'iris' ? { motifRef: upstreamImageUrl } : { patternRef: upstreamImageUrl }),
						// Helios predates the design id, so a Helios run has none to carry.
						designSessionId: upstreamDesignId ?? current.designSessionId,
					}))
			: null;

	async function checkConnection() {
		setConnection(await ping(baseUrlRef.current));
		void refreshRuns(target);
	}

	// Resume is session-bound: a p_invoc_id from one session 409s in another. If
	// the field has moved since this result arrived, its button no longer applies.
	const sessionMoved = outcome?.kind === 'run' && outcomeSession !== null && outcomeSession !== target;

	const resultGroup = outcome?.kind === 'run' ? (groups.find((group) => group.runId === outcome.runId) ?? null) : null;
	const resultResumable =
		outcome?.kind === 'run' && (resultGroup ? resultGroup.resumable : outcome.result.status === 'failed');

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

			<div className="column">
				<InputPanel
					engine={engine}
					onEngine={switchEngine}
					fields={fields}
					onField={(key, value) => setFields((current) => ({ ...current, [key]: value }))}
					onCopyFromUpstream={copyFromUpstream}
					concept={concept}
					onConcept={setConcept}
					sessionField={sessionField}
					onSessionField={setSessionField}
					sessions={sessions}
					onForgetSession={(id) => setSessions((current) => forget(current, id))}
					baseUrl={baseUrl}
					onBaseUrl={setBaseUrl}
					inFlight={inFlight !== null}
					validationError={validationError}
					onGenerate={requestGenerate}
					onPing={() => void checkConnection()}
					connection={connection}
				/>
				<p className="hint">
					Default base URL for {ENGINE_SPECS[engine].label} is <code>{ENGINE_SPECS[engine].defaultBaseUrl}</code>, remembered per engine. <code>GET /runs</code>, <code>GET /</code> and the image bytes are all
					free; only <code>/generate</code> and <code>/resume</code> cost anything.
				</p>
			</div>

			<div className="column">
				<ImageOutput
					engine={engine}
					outcome={outcome}
					waitingMs={inFlight ? elapsedMs : null}
					onResume={
						resultResumable && !sessionMoved && !inFlight && outcome?.kind === 'run'
							? () => requestResume(outcome.runId)
							: null
					}
					resumeNote={outcome?.kind === 'run' ? describeBriefHistory(briefHistory(groups, outcome.runId)) : null}
					resumeBlockedReason={
						sessionMoved
							? `This run was made in session "${outcomeSession}" and the field now reads "${target}". Resume is session-bound — a p_invoc_id from one session is refused in another with "no run with that id in this session". Switch back to resume it.`
							: null
					}
				/>

				<Scratchpad sections={sections} waitingMs={inFlight ? elapsedMs : null} />

				<RunHistory
					engine={engine}
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
