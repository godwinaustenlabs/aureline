// `vitest/config` rather than `vite`, so the `test` block below typechecks. It
// re-exports Vite's own `defineConfig` widened with vitest's options.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * The two ports are pinned with `strictPort` on purpose.
 *
 * The worker grants exactly the origins in its `ALLOWED_ORIGINS` var, and 5173
 * and 4173 are two of them. Vite's default behaviour when a port is busy is to
 * quietly take the next one, which would put the dev server on an origin the
 * backend refuses — and a refused preflight surfaces as an unexplained CORS
 * failure on every call. Failing to start is a much shorter afternoon.
 */
export default defineConfig({
	plugins: [react()],

	server: { port: 5173, strictPort: true },
	preview: { port: 4173, strictPort: true },

	optimizeDeps: {
		// `@aureline/shared-types` resolves, through the npm workspace symlink, to
		// raw TypeScript (`src/index.ts`) rather than to built output. Excluding it
		// keeps the dependency pre-bundler out of it and lets Vite's normal
		// TS transform handle it as ordinary source.
		exclude: ['@aureline/shared-types'],
	},

	build: { outDir: 'dist' },

	test: {
		// The domain modules under test are pure, and the one render test uses
		// `react-dom/server`, so nothing here needs a DOM.
		environment: 'node',
		include: ['src/**/*.test.{ts,tsx}'],
	},
});
