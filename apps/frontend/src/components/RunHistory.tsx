import { localTime, shortId, usd } from '../domain/format';
import { ENGINE_SPECS, type Engine } from '../domain/engines';
import { briefHistory, describeBriefHistory, type RunGroup } from '../domain/runView';

interface Props {
	engine: Engine;
	groups: RunGroup[];
	session: string;
	loading: boolean;
	error: string | null;
	/** The run whose rows the scratchpad is currently showing. */
	selectedId: string | null;
	onSelect: (pInvocId: string) => void;
	onResume: (pInvocId: string) => void;
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
export function RunHistory({ engine, groups, session, loading, error, selectedId, onSelect, onResume, onRefresh, busy }: Props) {
	// Atlas writes one row per invocation and has no text stage at all, so a
	// `text` column there would be a column of permanent em-dashes.
	const singleRow = ENGINE_SPECS[engine].rowsPerInvocation === 1;
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
									<th>{ENGINE_SPECS[engine].resultIdField}</th>
									<th>when</th>
									{!singleRow && <th>text</th>}
									<th>{singleRow ? 'status' : 'image'}</th>
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
									const spentSoFar = describeBriefHistory(briefHistory(groups, group.runId));

									return (
									<tr key={group.runId} className={group.runId === selectedId ? 'current' : undefined}>
										<td>
											<button
												className="small"
												onClick={() => onSelect(group.runId)}
												title={`${group.runId} — show this run in the scratchpad`}
											>
												{shortId(group.runId)}
											</button>
										</td>
										<td>{localTime(group.createdAt)}</td>
										{!singleRow && (
											<td>
												<Status status={group.text?.status ?? null} />
											</td>
										)}
										<td>
											<Status status={group.image?.status ?? null} />
										</td>
										<td>{usd(group.totalCostUsd)}</td>
										<td>{group.lineage.attempt === null ? '—' : `attempt ${group.lineage.attempt}`}</td>
										<td>
											{group.resumable && (
												<div className="resume-cell">
													<button className="small" disabled={busy} onClick={() => onResume(group.runId)}>
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
					{singleRow
						? 'A run is offered a Resume when its single row failed. Atlas writes one row per invocation and has no text stage, so there is no "planner succeeded, image failed" pair to look for — a completed run already has its image. That'
						: 'A run is offered a Resume when its text row is completed and its image row is failed or absent. That'}{' '}
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
