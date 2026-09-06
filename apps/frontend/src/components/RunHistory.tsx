import { localTime, shortId, usd } from '../domain/format';
import { briefHistory, describeBriefHistory, type RunGroup } from '../domain/runView';

interface Props {
	groups: RunGroup[];
	session: string;
	loading: boolean;
	error: string | null;
	/** The run whose rows the scratchpad is currently showing. */
	selectedId: string | null;
	onSelect: (pipelineId: string) => void;
	onResume: (pipelineId: string) => void;
	onRefresh: () => void;
	/** Resume is a billed call, so it is locked out while one is in flight. */
	busy: boolean;
}

/**
 * Every run in the current session, from `GET /runs`.
 *
 * **History is short by design and that is not a bug.** The Durable Object keeps
 * only the newest `retention_limit` fully completed runs, default 5, and prunes
 * on every invocation. Failed runs are never pruned, so those accumulate.
 * Everything ever run is in D1 permanently, but there is no route that lists D1
 * and this page does not add one.
 */
export function RunHistory({ groups, session, loading, error, selectedId, onSelect, onResume, onRefresh, busy }: Props) {
	return (
		<section className="panel">
			<header>
				<h2>Run history</h2>
				<span className="hint">
					session <code>{session}</code>
				</span>
				<span className="spacer" />
				<button className="small" onClick={onRefresh} disabled={loading} title="GET /runs — free and read-only">
					{loading ? 'Reading…' : 'Refresh'}
				</button>
			</header>
			<div className="panel-body">
				{error && <div className="hint error">{error}</div>}

				{groups.length === 0 && !error ? (
					<p className="empty" style={{ padding: 0 }}>
						No runs in this Durable Object. Either nothing has been run under <code>{session}</code>, or its completed runs have been
						pruned — the DO keeps only the newest few and prunes on every invocation.
					</p>
				) : (
					<div className="table-scroll">
						<table>
							<thead>
								<tr>
									<th>pipeline_id</th>
									<th>design</th>
									<th>mode</th>
									<th>when</th>
									<th>text</th>
									<th>image</th>
									<th>total cost</th>
									<th>lineage</th>
									<th />
								</tr>
							</thead>
							<tbody>
								{groups.map((group) => {
									// What resuming this one would actually buy. Computed from rows
									// already on screen — no extra call, and `GET /runs` stays the
									// only read this page makes.
									const spentSoFar = describeBriefHistory(briefHistory(groups, group.pipelineId));

									return (
									<tr key={group.pipelineId} className={group.pipelineId === selectedId ? 'current' : undefined}>
										<td>
											<button
												className="small"
												onClick={() => onSelect(group.pipelineId)}
												title={`${group.pipelineId} — show this run in the scratchpad`}
											>
												{shortId(group.pipelineId)}
											</button>
										</td>
										{/*
										 * The design id, shortened the same way the pipeline id above is.
										 * Not a button: it selects nothing. It is here to be *compared* —
										 * the same value in the Helios table and the Iris table is what
										 * says one engine coloured the other's pattern.
										 */}
										<td>
											<code title={group.designSessionId || 'not recorded on this row'}>
												{group.designSessionId ? shortId(group.designSessionId) : '—'}
											</code>
										</td>
										{/*
										 * What the classifier decided. A dash rather than a default:
										 * an Iris run has no classification, a Helios run from before
										 * Phase 2 has none, and one that failed before classifying has
										 * none. Rendering "tile" for any of those would put a decision
										 * on screen that nothing made.
										 */}
										<td>
											{group.classification === null ? (
												'—'
											) : (
												<span title={group.classification.garmentPart ?? 'no garment part'}>
													{group.classification.mode}
													{group.classification.garmentPart && ` · ${group.classification.garmentPart}`}
												</span>
											)}
										</td>
										<td>{localTime(group.createdAt)}</td>
										<td>
											<Status status={group.text?.status ?? null} />
										</td>
										<td>
											<Status status={group.image?.status ?? null} />
										</td>
										<td>{usd(group.totalCostUsd)}</td>
										<td>{group.lineage.attempt === null ? '—' : `attempt ${group.lineage.attempt}`}</td>
										<td>
											{group.resumable && (
												<div className="resume-cell">
													<button className="small" disabled={busy} onClick={() => onResume(group.pipelineId)}>
														Resume
													</button>
													{spentSoFar && <span className="hint warn">{spentSoFar}</span>}
												</div>
											)}
										</td>
									</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}

				<p className="hint">
					A run is offered a Resume when its text row is <code>completed</code> and its image row is <code>failed</code> or absent. That
					check is client-side and approximate on purpose: the backend refuses with a 409 and a readable reason, and showing that
					reason is a perfectly good outcome. A resume creates a <strong>new</strong> run — the original row is never overwritten,
					which is why a failed run keeps offering Resume even after one of its resumes has succeeded. Each image call sets{' '}
					<code>skipCache</code>, so the same params produce a different picture every time and another resume is a fresh variation
					rather than a retry. How many are allowed is capped server-side; past the cap you get a 409 that says so.
				</p>
			</div>
		</section>
	);
}

/** An absent row is its own state, not a blank. A run that failed before the
 *  planner produced anything has no image row at all, and that is legal. */
function Status({ status }: { status: string | null }) {
	return <span className={`chip ${status ?? 'absent'}`}>{status ?? 'absent'}</span>;
}
