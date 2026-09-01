import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

/**
 * `StrictMode` double-invokes effects in dev, which is safe here only because
 * **no billed call ever happens in an effect**. `POST /generate` and
 * `POST /resume` are reachable from a click handler and nowhere else; the only
 * thing an effect calls is `GET /runs`, which is free and read-only forever.
 * That invariant is worth keeping — if it ever breaks, this page starts spending
 * money twice per render in development.
 */
const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
