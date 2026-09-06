import type { ReactNode } from 'react';
import { pretty } from '../domain/format';
import type { ScratchpadSection } from '../domain/scratchpad';
import { Waiting } from './Waiting';

/**
 * The debugging surface, and the reason this page exists.
 *
 * It fills in once, after the response arrives, from a follow-up `GET /runs` —
 * the numbers here are what the engine actually stored, not what the response
 * claimed. Where the engine stores nothing, it says so.
 */
export function Scratchpad({ sections, waitingMs }: { sections: ScratchpadSection[] | null; waitingMs: number | null }) {
	return (
		<section className="panel">
			<header>
				<h2>Scratchpad</h2>
				<span className="spacer" />
				<span className="hint">reconstructed from GET /runs — free and read-only</span>
			</header>
			<div className="panel-body">
				{waitingMs !== null && <Waiting elapsedMs={waitingMs} what="Nothing is stored yet" />}

				{!sections && waitingMs === null && (
					<p className="empty" style={{ padding: 0 }}>
						Run something, or pick a run from the history below, and everything the engine recorded about it appears here.
					</p>
				)}

				{sections?.map((section) => (
					<div className="section" key={section.title}>
						<h3 className="section-title">{section.title}</h3>
						{section.note && <p className="section-note">{section.note}</p>}
						<dl className="entries">
							{section.entries.map((entry) => (
								<Entry key={entry.label} label={entry.label} missing={entry.missing}>
									{entry.json !== undefined ? <pre>{pretty(entry.json)}</pre> : entry.value}
								</Entry>
							))}
						</dl>
					</div>
				))}
			</div>
		</section>
	);
}

/**
 * One `dt`/`dd` pair.
 *
 * A labelled gap gets its own styling rather than an empty cell. That difference
 * is the point of the whole "not available" idea: an empty box reads as a page
 * bug, a labelled gap reads as an engine gap, which is what it is.
 */
function Entry({ label, missing, children }: { label: string; missing?: boolean; children: ReactNode }) {
	return (
		<>
			<dt>{label}</dt>
			<dd className={missing ? 'missing' : undefined}>{children}</dd>
		</>
	);
}
