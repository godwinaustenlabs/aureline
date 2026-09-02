import { usd } from '../domain/format';
import type { IrisCallOutcome } from '../domain/irisOutcome';
import { IRIS_GENERATE_COST_USD } from '../api/iris';
import { Waiting } from './Waiting';
import { RunHistory } from './RunHistory';
import type { RunGroup } from '../domain/runView';
import { ReferenceImageField } from './ReferenceImageField';

/**
 * The Iris screen: colour an existing black-and-white motif.
 *
 * Iris does not invent a pattern. It takes one Helios already made — named by
 * `motif_ref`, an **R2 key** and not a URL — and colours it. So this screen is
 * only usable after a Helios run, and the two fields that carry across from it
 * are filled in rather than typed.
 *
 * `design_session_id` is the one that matters. Keeping Helios's value here is
 * what makes the pattern and its colouring one design; a fresh id produces a
 * coloured image nothing can trace back to the motif it came from.
 */

interface Props {
	concept: string;
	onConcept: (value: string) => void;
	motifRef: string;
	onMotifRef: (value: string) => void;
	designSessionId: string;
	onDesignSessionId: (value: string) => void;
	sessionField: string;
	onSessionField: (value: string) => void;
	baseUrl: string;
	onBaseUrl: (value: string) => void;
	inFlight: boolean;
	elapsedMs: number;
	validationError: string | null;
	onGenerate: () => void;
	onPing: () => void;
	connection: { ok: boolean; message: string } | null;
	referenceImage: File | null;
	onReferenceImage: (file: File | null) => void;
	outcome: IrisCallOutcome | null;
	/** Where the motif and design id came from, when they were carried across. */
	handoffNote: string | null;

	/**
	 * Iris's own run history, from Iris's own `GET /runs`.
	 *
	 * Iris serves the identical route and envelope Helios does, so `RunHistory`
	 * is reused unchanged rather than rebuilt — `iris_runs` is `helios_runs` plus
	 * `motif_ref`, and both engines write the same `root` / `resumed_from` /
	 * `attempt` markers that `runView` reads to work out lineage.
	 */
	groups: RunGroup[];
	session: string;
	rowsLoading: boolean;
	rowsError: string | null;
	selectedId: string | null;
	onSelect: (pipelineId: string) => void;
	onResume: (pipelineId: string) => void;
	onRefreshRuns: () => void;
	/** The stored image of a run picked out of the history, rebuilt from its R2
	 *  key — a row records the key and never the URL. */
	historyImage: { url: string; pipelineId: string } | null;
}

export function IrisPanel(props: Props) {
	const { concept, motifRef, designSessionId, sessionField, baseUrl, inFlight, outcome, handoffNote } = props;

	return (
		<>
			<div className="column">
				<section className="panel">
					<header>
						<h2>Iris input</h2>
					</header>
					<div className="panel-body">
						{handoffNote && <p className="hint">{handoffNote}</p>}

						<div className="field">
							<label htmlFor="iris-motif">Motif ref</label>
							<input
								id="iris-motif"
								type="text"
								value={motifRef}
								placeholder="patterns/9c1760bb-....jpg"
								onChange={(event) => props.onMotifRef(event.target.value)}
							/>
							<span className="hint">
								The R2 <strong>key</strong> of the pattern to colour, not a URL. Helios writes{' '}
								<code>patterns/[pipeline_id].jpg</code> into the shared bucket and Iris reads it straight
								out, so a URL here passes the schema and then fails at the bucket read.
							</span>
						</div>

						<div className="field">
							<label htmlFor="iris-concept">Concept</label>
							<textarea
								id="iris-concept"
								value={concept}
								maxLength={1000}
								placeholder="deep navy and gold, rich and opulent"
								onChange={(event) => props.onConcept(event.target.value)}
							/>
							<span className="hint">
								{concept.trim().length} / 1000 characters. Colour only: Iris ignores shape, motif, scale and
								repeat, because Helios already decided those.
							</span>
							{props.validationError && <span className="hint error">{props.validationError}</span>}
						</div>

						<div className="field">
							<label htmlFor="iris-design">Design session id</label>
							<input
								id="iris-design"
								type="text"
								value={designSessionId}
								onChange={(event) => props.onDesignSessionId(event.target.value)}
							/>
							<span className="hint">
								Carried from the Helios run, unchanged. This is what ties the pattern and its colouring into
								one design. Change it and the two become unrelated runs.
							</span>
						</div>

						<div className="field">
							<label htmlFor="iris-session">Session id</label>
							<input
								id="iris-session"
								type="text"
								value={sessionField}
								placeholder="default"
								onChange={(event) => props.onSessionField(event.target.value)}
							/>
							<span className="hint">
								Routing only, and Iris keeps a different Durable Object namespace from Helios: the same name
								here is not the same object.
							</span>
						</div>

						<ReferenceImageField
							id="iris-reference"
							file={props.referenceImage}
							onFile={props.onReferenceImage}
						/>

						<div className="field">
							<label htmlFor="iris-base">Iris base URL</label>
							<div className="row">
								<input
									id="iris-base"
									type="text"
									value={baseUrl}
									onChange={(event) => props.onBaseUrl(event.target.value)}
								/>
								<button className="small" onClick={props.onPing} title="GET / - free">
									Ping
								</button>
							</div>
							{props.connection && (
								<span className={props.connection.ok ? 'hint' : 'hint error'}>{props.connection.message}</span>
							)}
						</div>

						<div className="banner-row">
							<button onClick={props.onGenerate} disabled={inFlight}>
								{inFlight ? 'Colouring...' : `Colour it - ${usd(IRIS_GENERATE_COST_USD)}`}
							</button>
							<span className="spacer" />
							<span className="hint">One planner call plus one image call. Real money.</span>
						</div>
					</div>
				</section>
			</div>

			<div className="column">
				<section className="panel">
					<header>
						<h2>Iris response</h2>
					</header>
					<div className="panel-body">
						{inFlight && <Waiting elapsedMs={props.elapsedMs} what="Waiting on Iris" />}

						{!outcome && !inFlight && !props.historyImage && (
							<p className="empty" style={{ padding: 0 }}>
								Nothing yet. Run Helios first, and the motif ref and design id land here automatically — or
								pick an earlier run from the history below.
							</p>
						)}

						{props.historyImage ? (
							<figure style={{ margin: 0 }}>
								<figcaption className="hint" style={{ marginBottom: 6 }}>
									From the run history — <code>{props.historyImage.pipelineId}</code>. Rebuilt from the
									stored R2 key, because a row records the key and never the URL.
								</figcaption>
								<div className="pattern">
									<img src={props.historyImage.url} alt="The colouring this run produced" />
								</div>
								<figcaption className="hint" style={{ marginTop: 6, wordBreak: 'break-all' }}>
									{props.historyImage.url}
								</figcaption>
							</figure>
						) : (
							outcome && <IrisResultView outcome={outcome} />
						)}
					</div>
				</section>

				<RunHistory
					groups={props.groups}
					session={props.session}
					loading={props.rowsLoading}
					error={props.rowsError}
					selectedId={props.selectedId}
					onSelect={props.onSelect}
					onResume={props.onResume}
					onRefresh={props.onRefreshRuns}
					busy={inFlight}
				/>
			</div>
		</>
	);
}

/**
 * The result.
 *
 * The raw body is always shown. The reading of it is in addition, never instead:
 * this is a debugging console and the exact bytes are the point.
 */
function IrisResultView({ outcome }: { outcome: IrisCallOutcome }) {
	if (outcome.kind === 'transport') {
		return (
			<>
				<div className="banner error">
					<strong>Never became a run.</strong>
					<p>{outcome.message}</p>
					<p className="hint">
						{outcome.status === null ? 'No answer at all.' : `HTTP ${outcome.status}.`} Nothing was written and
						nothing was billed.
					</p>
				</div>
				<RawBody raw={outcome.raw} />
			</>
		);
	}

	if (outcome.kind === 'refusal') {
		return (
			<>
				<div className="banner">
					<strong>Refused.</strong>
					<p>{outcome.reason}</p>
					<p className="hint">A 409 is a precondition, not a failure. Nothing ran and nothing was billed.</p>
				</div>
				<RawBody raw={outcome.raw} />
			</>
		);
	}

	const { result } = outcome;

	return (
		<>
			<div className={result.status === 'completed' ? 'banner' : 'banner error'}>
				<strong>{result.status === 'completed' ? 'Run completed' : `Run ${result.status}`}</strong>{' '}
				<span className="chip">{result.status}</span>
				<p>
					<code>{result.pipeline_id}</code>
				</p>
				{result.error && <p className="hint error">{result.error}</p>}
				<p className="hint">
					Image cost as reported here:{' '}
					<strong>{result.cost_usd === null ? 'not recorded' : usd(result.cost_usd)}</strong>. This is the image
					alone, so the planner cost is not in it.
				</p>
			</div>

			{result.image_url && (
				<figure style={{ margin: 0 }}>
					<div className="pattern">
						{/* Used exactly as it arrived. Iris builds it from its own origin. */}
						<img src={result.image_url} alt="The coloured motif" />
					</div>
					<figcaption className="hint" style={{ marginTop: 6, wordBreak: 'break-all' }}>
						{result.image_url}
						{result.width && result.height ? ` - ${result.width} x ${result.height}` : ''}
					</figcaption>
				</figure>
			)}

			{result.params && (
				<div className="field">
					<label>Colour parameters the planner chose</label>
					<pre className="wrap">{JSON.stringify(result.params, null, 2)}</pre>
				</div>
			)}

			<RawBody raw={outcome.raw} />
		</>
	);
}

function RawBody({ raw }: { raw: string }) {
	return (
		<div className="field">
			<label>Raw response body, exactly as it arrived</label>
			<pre className="wrap">{raw}</pre>
		</div>
	);
}
