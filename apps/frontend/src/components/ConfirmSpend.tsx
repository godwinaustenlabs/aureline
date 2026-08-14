import { useEffect, useRef } from 'react';
import { usd } from '../domain/format';

/**
 * The gate in front of every billed call.
 *
 * `wrangler dev` bills the real account, so there is no environment where a
 * stray click is free. Generate and resume each get their own confirm naming
 * their own cost — a resume is pure additional spend on a run that was already
 * paid for, which is a different decision from making a new one.
 */

export interface SpendRequest {
	title: string;
	costUsd: number;
	/** What the money buys, in one sentence. */
	detail: string;
	confirmLabel: string;
	onConfirm: () => void;
}

export function ConfirmSpend({ request, onCancel }: { request: SpendRequest; onCancel: () => void }) {
	const confirmRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		confirmRef.current?.focus();

		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onCancel();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onCancel]);

	return (
		<div className="backdrop" onClick={onCancel}>
			<div className="dialog" role="dialog" aria-modal="true" aria-label={request.title} onClick={(event) => event.stopPropagation()}>
				<h2>{request.title}</h2>
				<div className="cost">about {usd(request.costUsd)}</div>
				<p>{request.detail}</p>
				<p>
					This is real money on a real Cloudflare account. Local dev is billed exactly like production — the <code>AI</code> binding has
					no local simulator.
				</p>
				<div className="actions">
					<button onClick={onCancel}>Cancel</button>
					<button ref={confirmRef} className="primary" style={{ width: 'auto' }} onClick={request.onConfirm}>
						{request.confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}
