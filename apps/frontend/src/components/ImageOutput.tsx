import { RESUME_COST_USD } from '../api/client';
import type { CallOutcome } from '../domain/outcome';
import { failedStage, failureDetail } from '../domain/outcome';
import { usd } from '../domain/format';
import { Waiting } from './Waiting';

interface Props {
	outcome: CallOutcome | null;
	waitingMs: number | null;
	/** Null when the result on screen cannot be resumed, or when resuming it
	 *  would now go to the wrong Durable Object. */
	onResume: (() => void) | null;
	resumeBlockedReason: string | null;
	/** What this brief has already produced, when it has produced anything. Shown
	 *  beside the button so the spend is an informed one. */
	resumeNote: string | null;
}

/**
 * What came back: the outcome, the image, and the exact response body.
 *
 * **The raw JSON is always visible.** The prettified reading of the result is in
 * addition to it, never instead of it — this is a debugging tool and the exact
 * bytes are the point.
 */
export function ImageOutput({ outcome, waitingMs, onResume, resumeBlockedReason, resumeNote }: Props) {
	return (
		<section className="panel">
			<header>
				<h2>Response</h2>
			</header>
			<div className="panel-body">
				{waitingMs !== null && <Waiting elapsedMs={waitingMs} what="Waiting on the worker" />}

				{!outcome && waitingMs === null && (
					<p className="empty" style={{ padding: 0 }}>
						Nothing yet. A generate costs about $0.0029 of real money and confirms first.
					</p>
				)}

				{outcome && (
					<>
						<Banner outcome={outcome} onResume={onResume} resumeBlockedReason={resumeBlockedReason} resumeNote={resumeNote} />
						{outcome.kind === 'run' && outcome.result.image_url && (
							<figure style={{ margin: 0 }}>
								<div className="pattern">
									{/*
									 * `image_url` is used exactly as it arrived. The worker builds it
									 * from its own origin, so it already points at the right host when
									 * the two are deployed apart — reassembling it from the base URL
									 * field would break precisely when that matters. A plain <img>
									 * loads it cross-origin with no CORS involvement at all.
									 */}
									<img src={outcome.result.image_url} alt="The generated pattern" />
								</div>
								<figcaption className="hint" style={{ marginTop: 6, wordBreak: 'break-all' }}>
									{outcome.result.image_url}
								</figcaption>
							</figure>
						)}

						<div className="field">
							<label>Raw response body, exactly as it arrived</label>
							<pre className="wrap">{outcome.raw}</pre>
						</div>
					</>
				)}
			</div>
		</section>
	);
}

function Banner({ outcome, onResume, resumeBlockedReason, resumeNote }: Pick<Props, 'outcome' | 'onResume' | 'resumeBlockedReason' | 'resumeNote'>) {
	// A refusal is a third outcome class: not an error and not a run. Nothing was
	// written and nothing was billed, and the worker's sentence is written to be
	// shown to a person verbatim, so it is shown verbatim.
	if (outcome?.kind === 'refusal') {
		return (
			<div className="banner-row refusal">
				<div>
					<div className="title">Refused — nothing was written and nothing was billed</div>
					<div className="verbatim">{outcome.reason}</div>
					<div className="body" style={{ marginTop: 6 }}>
						HTTP 409. The run you tried to resume is untouched.
					</div>
				</div>
			</div>
		);
	}

	// Never became a run, so there is no p_invoc_id and nothing to resume.
	if (outcome?.kind === 'transport') {
		return (
			<div className="banner-row transport">
				<div>
					<div className="title">{outcome.status === null ? 'The request never reached the worker' : `HTTP ${outcome.status}`}</div>
					<div className="verbatim">{outcome.message}</div>
					<div className="body" style={{ marginTop: 6 }}>
						This never became a run, so it carries no <code>p_invoc_id</code> and cost nothing.
					</div>
				</div>
			</div>
		);
	}

	if (!outcome) return null;

	const { result } = outcome;

	// HTTP 200 either way. `status` is what decides, not the response code — the
	// worker returns non-200 only for things that never became a run.
	const failed = result.status === 'failed';
	const stage = failedStage(result.error);

	return (
		<div className={`banner-row ${failed ? 'fail' : 'ok'}`}>
			<div style={{ flex: 1, minWidth: 0 }}>
				<div className="title">
					{failed ? 'Run failed' : 'Run completed'} <span className={`chip ${result.status}`}>{result.status}</span>
				</div>
				<div className="body">
					<code>{result.p_invoc_id}</code>
				</div>
				{failed && (
					<div className="verbatim" style={{ marginTop: 6 }}>
						{stage ? `${stage} stage: ${failureDetail(result.error)}` : (result.error ?? 'no error message')}
					</div>
				)}
				<div className="body" style={{ marginTop: 6 }}>
					Image cost as reported here: <strong>{usd(result.cost_usd)}</strong>. This is the image alone — the planner cost is on the text
					row and the real total is in the scratchpad.
				</div>
				{onResume && (
					<button className="small" style={{ marginTop: 8 }} onClick={onResume}>
						Resume this run — about {usd(RESUME_COST_USD)}
					</button>
				)}
				{onResume && resumeNote && (
					<div className="hint warn" style={{ marginTop: 6 }}>
						{resumeNote}
					</div>
				)}
				{resumeBlockedReason && (
					<div className="hint warn" style={{ marginTop: 8 }}>
						{resumeBlockedReason}
					</div>
				)}
			</div>
		</div>
	);
}
