/**
 * The one place a test double is typed as `Env`.
 *
 * `Env` is generated from `wrangler.jsonc` and describes real platform
 * bindings — `Ai`, `R2Bucket`, `KVNamespace`, `D1Database`. A test double
 * cannot structurally satisfy any of them: `R2Bucket` alone declares a dozen
 * methods no test calls. That is a genuinely untyped third-party boundary, and
 * AGENTS.md §4 allows exactly one cast for it.
 *
 * **Doing it once, here, is the point.** Scattered `as unknown as Env` casts at
 * every call site are how a suite stops checking anything without anyone
 * noticing: the cast silences the whole call, not just the argument. With one
 * helper, every suite passes a real object and only this line is unchecked.
 *
 * Not a `.test.ts` file, so vitest does not collect it.
 */
export function fakeEnv(bindings: Record<string, unknown>): Env {
	return bindings as unknown as Env;
}
