import { z } from "zod";
import type { IrisD1Db } from "./db/client";
import type { PromptSlot } from "./db/schema.d1";
import { getPrompt } from "./repository/prompts.repository";

/**
 * Runtime config resolved from the `CONFIG` KV namespace, with the
 * `wrangler.jsonc` vars as committed fallbacks.
 *
 * KV holds the live value and is edited by hand from the Cloudflare dashboard
 * (namespace "IRIS_CONFIG"); this app only ever reads it. There is one
 * namespace, shared by local dev and production — see
 * docs/adr/0008-runtime-config-resolved-from-kv.md.
 */

/** Where a resolved value came from. */
export type ConfigSource = "kv" | "var";

/**
 * The planner model and how to call it.
 *
 * Only `model` is required. The vars fallback supplies a bare model id, so
 * every tuning field has to survive being absent.
 */
export interface TextModelConfig {
	model: string;
	temperature?: number;
}

/** The image model and its generation parameters. */
export interface ImageModelConfig {
	model: string;
	width?: number;
	height?: number;
	steps?: number;
}

/** Resolved runtime config for a single pipeline invocation. */
export interface IrisConfig {
	textModel: TextModelConfig;
	/**
	 * The vision-capable planner, used for **every** request rather than only
	 * those carrying a reference image.
	 *
	 * One model means one set of planner behaviour to tune and one prompt that
	 * has to work. Switching per request would mean two of each, and a class of
	 * bug that only appears once an image is attached — which is the hardest
	 * kind to notice. `textModel` stays as the fallback, so reverting is a KV
	 * edit rather than a deploy (ADR-0008, ADR-SHARED-0003).
	 */
	visionTextModel: TextModelConfig;
	imageModel: ImageModelConfig;
	maxRetries: number;
	retentionLimit: number;
	/**
	 * How many times one run may be resumed. Counts resumes only, so 3 means
	 * an original plus three retries. Every retry spends the image model, so this
	 * is the ceiling on what a single concept can cost.
	 */
	maxResumeAttempts: number;
	/**
	 * The model that runs the agentic research stage, or an empty model id when
	 * retrieval is switched off.
	 *
	 * Read through `researchModelFor`, never directly: the empty case is the off
	 * switch and it is a decision that gets logged.
	 */
	researchModel: TextModelConfig;
	/**
	 * No `classifierModel` here, unlike Helios.
	 *
	 * `phase-2-plan.md` §5.2 asks for the same seven keys on both engines, and
	 * that is one key too many. Iris never classifies — §3 settles that
	 * classification happens once in Helios and every other engine reads the
	 * answer — so a `classifier_model` here would be permanently dead, not
	 * awaiting a caller. §9.1 of the same plan deletes the `iris_color` prompt
	 * slot for exactly that, so adding a dead config key in the same phase would
	 * contradict it. Six keys on Iris, seven on Helios.
	 */
	/** Ceiling on billed model calls in the research loop. */
	maxToolIterations: number;
	/** Passed to AI Search as `max_num_results`. */
	maxSearchResults: number;
	/** Below this many characters of retrieved text, a result is thin. */
	minChunkChars: number;
	/** Passed to AI Search as `match_threshold`. */
	searchMatchThreshold: number;
	/**
	 * Whether AI Search rewrites the query with its own LLM before searching.
	 *
	 * Off by default. The research model is already writing the query itself, so
	 * leaving rewrite on adds a second billed model call we do not control, per
	 * search. The key exists so it can be A/B'd from KV later.
	 */
	queryRewrite: boolean;
	/** Per-field provenance, for the log line. */
	source: Record<
		| "textModel"
		| "visionTextModel"
		| "imageModel"
		| "maxRetries"
		| "retentionLimit"
		| "maxResumeAttempts"
		| "researchModel"
		| "maxToolIterations"
		| "maxSearchResults"
		| "minChunkChars"
		| "searchMatchThreshold"
		| "queryRewrite",
		ConfigSource
	>;
}

/** How long the edge may serve a cached KV read, in seconds.
 *
 * 60s is already the propagation floor for KV writes, so a shorter TTL buys
 * nothing and only costs edge reads. */
export const CONFIG_CACHE_TTL = 60;

/**
 * Unknown keys are stripped rather than rejected, so a field added in the
 * dashboard ahead of the code that reads it is ignored instead of invalidating
 * the whole value.
 */
const TextModelSchema = z.object({
	model: z.string().trim().min(1),
	temperature: z.number().min(0).max(2).optional(),
});

const ImageModelSchema = z.object({
	model: z.string().trim().min(1),
	width: z.number().int().min(64).max(2048).optional(),
	height: z.number().int().min(64).max(2048).optional(),
	steps: z.number().int().min(1).max(50).optional(),
});

/**
 * `TextModelSchema` without the `min(1)`, because for `research_model` an empty
 * id is a value rather than a mistake.
 *
 * `research_model: ""` is the off switch and it has to work from KV with no
 * deploy. Under `TextModelSchema` it would fail `min(1)`, warn once per
 * invocation, and fall back to `RESEARCH_MODEL` — which is a configured model.
 * The key meant to switch retrieval **off** would switch it **on**, and warn
 * about it on every request while doing so. `researchModelFor` is the one place
 * the empty id becomes a decision, and it logs it there instead.
 */
const OptionalTextModelSchema = z.object({
	model: z.string().trim(),
	temperature: z.number().min(0).max(2).optional(),
});

/**
 * KV holds text, so a boolean arrives as a word. The accepted spellings are the
 * ones a person actually types into a dashboard.
 *
 * Deliberately **not** `Boolean(raw)` or `raw !== ""`. Under either of those the
 * string `"false"` is true, so the key set to turn a billed feature off would
 * turn it on — and `ai_search_query_rewrite` being on means a second Workers AI
 * call per search that nothing in this repo controls.
 */
const BooleanFromStringSchema = z
	.enum(["true", "false", "1", "0", "yes", "no"])
	.transform((value) => value === "true" || value === "1" || value === "yes");

/**
 * The model keys hold a JSON object (`{ "model": ..., "temperature": ... }`),
 * but the dashboard is hand-edited and a bare model id is the obvious thing to
 * type. Accept both: anything not starting with `{` is treated as the model id.
 *
 * Returns `null` for malformed JSON, which fails validation and falls back to
 * the var like any other bad value.
 */
function prepareModelValue(raw: string): unknown {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("{")) {
		return { model: trimmed };
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}

/** Reads a numeric var, falling back to a last resort if it is unusable. */
function numberFromVar(raw: string | undefined, name: string, lastResort: number): number {
	const parsed = Number(raw);
	if (!raw || !Number.isFinite(parsed)) {
		// Only reachable if wrangler.jsonc itself is broken. Warns rather than
		// throwing: `resolveConfig` runs outside `runPipeline`'s try block, so a
		// throw here would escape as an opaque 500 instead of a settled result.
		console.warn(
			`config: fallback var ${name} is missing or not a number (${JSON.stringify(raw)}), using ${lastResort}. Fix wrangler.jsonc.`
		);
		return lastResort;
	}
	return parsed;
}

/**
 * Reads a boolean var, falling back to a last resort if it is unusable.
 *
 * Hands back a real boolean rather than the string wrangler stores, because the
 * vars are not re-validated by `resolveConfig` — whatever this returns lands in
 * the config object as-is, and `"false"` is a truthy string.
 */
function booleanFromVar(raw: string | undefined, name: string, lastResort: boolean): boolean {
	const normalised = raw?.trim().toLowerCase();

	if (normalised === "true" || normalised === "1" || normalised === "yes") return true;
	if (normalised === "false" || normalised === "0" || normalised === "no") return false;

	console.warn(
		`config: fallback var ${name} is missing or not a boolean (${JSON.stringify(raw)}), using ${lastResort}. Fix wrangler.jsonc.`
	);
	return lastResort;
}

/**
 * Rejects a blank KV value so it falls back instead of being coerced.
 *
 * `z.coerce.number()` reads `""` as `0`. Every numeric key that existed before
 * Phase 2 has `min(1)`, so a blank value failed validation and fell back on its
 * own. `min_chunk_chars` and `search_match_threshold` both allow `0` as a real
 * value, so without this an accidentally-blanked dashboard field would be
 * *accepted* — silently disabling the thin-result check, or the score floor,
 * while `describeConfig` reported a perfectly ordinary `0`.
 *
 * `undefined` coerces to `NaN`, which fails, which falls back and warns. That
 * is the wanted behaviour.
 */
function rejectBlank(raw: string): unknown {
	return raw.trim() === "" ? undefined : raw;
}

/**
 * Exactly what this file reads out of `Env`, and nothing else.
 *
 * Declared structurally rather than as `Pick<Env, …>` on purpose: `wrangler
 * types` generates the vars as **literal** types (`MAX_RETRIES: "2"`), so a
 * `Pick` would only accept the one value currently in `wrangler.jsonc` and a
 * test exercising any other value could not build one without a cast. Widening
 * to `string` here is what lets `config.test.ts` pass real values instead of
 * casting its way past the type (AGENTS.md §4). The real `Env` still satisfies
 * it, because a string literal is assignable to `string`.
 *
 * The vars are optional because a missing one is a real runtime case:
 * `numberFromVar` warns and falls back rather than throwing.
 */
export type ConfigEnv = {
	/** Narrowed to the one call this file makes — the bulk read. A test then
	 * fakes one method instead of standing up a whole `KVNamespace`. */
	CONFIG: { get(keys: string[], options?: { cacheTtl?: number }): Promise<Map<string, string | null>> };
	PLANNER_MODEL: string;
	/** Optional, and the option is the point: an empty or absent value is the
	 * signal to fall back to `PLANNER_MODEL`, which is how this is turned off
	 * without a deploy. See `plannerModelFor`. */
	VISION_PLANNER_MODEL?: string;
	IMAGE_MODEL: string;
	MAX_RETRIES?: string;
	RETENTION_LIMIT?: string;
	MAX_RESUME_ATTEMPTS?: string;
	/** Optional, and the option is the point: an empty or absent value switches
	 * the whole research stage off, which is how retrieval is disabled without a
	 * deploy. See `researchModelFor`. */
	RESEARCH_MODEL?: string;
	MAX_TOOL_ITERATIONS?: string;
	MAX_SEARCH_RESULTS?: string;
	MIN_CHUNK_CHARS?: string;
	SEARCH_MATCH_THRESHOLD?: string;
	AI_SEARCH_QUERY_REWRITE?: string;
};

/**
 * One entry per KV key: how to prepare its raw text, how to validate it, what
 * to fall back to, and how to render it in the log line.
 *
 * `AI_GATEWAY_ID` is deliberately absent. An empty or misspelled gateway id
 * makes `buildAiRunOptions` return undefined, which silently sends the call
 * straight to Workers AI with no error and no gateway log — a routing outage a
 * dashboard typo should not be able to cause.
 */
const FIELDS = [
	{
		key: "text_model",
		field: "textModel",
		var: "PLANNER_MODEL",
		schema: TextModelSchema,
		prepare: prepareModelValue,
		// The var carries a bare model id, so the fallback has no tuning fields.
		fromVar: (env: ConfigEnv): unknown => ({ model: env.PLANNER_MODEL }),
		describe: (value: unknown) => describeModel(value as TextModelConfig),
	},
	{
		key: "vision_planner_model",
		field: "visionTextModel",
		var: "VISION_PLANNER_MODEL",
		schema: TextModelSchema,
		prepare: prepareModelValue,
		// Deliberately allowed to resolve to an empty model id. The vars are not
		// re-validated by `resolveConfig`, so an unset var lands here as `{ model:
		// "" }` — which `plannerModelFor` reads as "not configured" and answers by
		// falling back to `textModel`. That is the off switch, and it is a KV or
		// var edit rather than a deploy.
		fromVar: (env: ConfigEnv): unknown => ({ model: env.VISION_PLANNER_MODEL ?? "" }),
		describe: (value: unknown) => describeModel(value as TextModelConfig),
	},
	{
		key: "image_model",
		field: "imageModel",
		var: "IMAGE_MODEL",
		schema: ImageModelSchema,
		prepare: prepareModelValue,
		fromVar: (env: ConfigEnv): unknown => ({ model: env.IMAGE_MODEL }),
		describe: (value: unknown) => describeModel(value as ImageModelConfig),
	},
	{
		key: "max_retries",
		field: "maxRetries",
		var: "MAX_RETRIES",
		schema: z.coerce.number().int().min(1).max(5),
		prepare: (raw: string): unknown => raw,
		fromVar: (env: ConfigEnv): unknown => numberFromVar(env.MAX_RETRIES, "MAX_RETRIES", 2),
		describe: (value: unknown) => String(value),
	},
	{
		key: "retention_limit",
		field: "retentionLimit",
		var: "RETENTION_LIMIT",
		schema: z.coerce.number().int().min(1).max(100),
		prepare: (raw: string): unknown => raw,
		fromVar: (env: ConfigEnv): unknown => numberFromVar(env.RETENTION_LIMIT, "RETENTION_LIMIT", 5),
		describe: (value: unknown) => String(value),
	},
	{
		key: "max_resume_attempts",
		field: "maxResumeAttempts",
		var: "MAX_RESUME_ATTEMPTS",
		// Capped at 20 rather than left open: this is the number of times one
		// concept may spend the image model, so a fat-fingered dashboard edit
		// should not be able to authorise an unbounded bill.
		schema: z.coerce.number().int().min(1).max(20),
		prepare: (raw: string): unknown => raw,
		fromVar: (env: ConfigEnv): unknown => numberFromVar(env.MAX_RESUME_ATTEMPTS, "MAX_RESUME_ATTEMPTS", 3),
		describe: (value: unknown) => String(value),
	},
	{
		key: "research_model",
		field: "researchModel",
		var: "RESEARCH_MODEL",
		// The one key that accepts an empty model id, because empty is its off
		// switch rather than a bad value. See `OptionalTextModelSchema`.
		schema: OptionalTextModelSchema,
		prepare: prepareModelValue,
		fromVar: (env: ConfigEnv): unknown => ({ model: env.RESEARCH_MODEL ?? "" }),
		describe: (value: unknown) => describeModel(value as TextModelConfig),
	},
	{
		key: "max_tool_iterations",
		field: "maxToolIterations",
		var: "MAX_TOOL_ITERATIONS",
		// Capped at 10 for the same reason `max_resume_attempts` is capped at 20:
		// every iteration is a billed model call, so a fat-fingered dashboard edit
		// must not be able to authorise an unbounded loop (AGENTS.md §7).
		schema: z.coerce.number().int().min(1).max(10),
		prepare: (raw: string): unknown => raw,
		fromVar: (env: ConfigEnv): unknown => numberFromVar(env.MAX_TOOL_ITERATIONS, "MAX_TOOL_ITERATIONS", 3),
		describe: (value: unknown) => String(value),
	},
	{
		key: "max_search_results",
		field: "maxSearchResults",
		var: "MAX_SEARCH_RESULTS",
		schema: z.coerce.number().int().min(1).max(20),
		prepare: (raw: string): unknown => raw,
		fromVar: (env: ConfigEnv): unknown => numberFromVar(env.MAX_SEARCH_RESULTS, "MAX_SEARCH_RESULTS", 5),
		describe: (value: unknown) => String(value),
	},
	{
		key: "min_chunk_chars",
		field: "minChunkChars",
		var: "MIN_CHUNK_CHARS",
		schema: z.coerce.number().int().min(0).max(5000),
		// `rejectBlank` rather than the identity used above, because `0` is a legal
		// value here and `z.coerce.number()` reads `""` as `0`.
		prepare: rejectBlank,
		fromVar: (env: ConfigEnv): unknown => numberFromVar(env.MIN_CHUNK_CHARS, "MIN_CHUNK_CHARS", 200),
		describe: (value: unknown) => String(value),
	},
	{
		key: "search_match_threshold",
		field: "searchMatchThreshold",
		var: "SEARCH_MATCH_THRESHOLD",
		// Not an integer: this is a similarity score between 0 and 1.
		schema: z.coerce.number().min(0).max(1),
		prepare: rejectBlank,
		fromVar: (env: ConfigEnv): unknown =>
			numberFromVar(env.SEARCH_MATCH_THRESHOLD, "SEARCH_MATCH_THRESHOLD", 0.5),
		describe: (value: unknown) => String(value),
	},
	{
		key: "ai_search_query_rewrite",
		field: "queryRewrite",
		var: "AI_SEARCH_QUERY_REWRITE",
		schema: BooleanFromStringSchema,
		// Normalised here rather than inside the schema, so the schema stays a
		// plain enum and its error message names the values a person may type.
		prepare: (raw: string): unknown => raw.trim().toLowerCase(),
		fromVar: (env: ConfigEnv): unknown =>
			booleanFromVar(env.AI_SEARCH_QUERY_REWRITE, "AI_SEARCH_QUERY_REWRITE", false),
		describe: (value: unknown) => String(value),
	},
] as const;

const KEYS = FIELDS.map((entry) => entry.key);

/** Renders a model config as `id` or `id(temperature=1)` for the log line. */
function describeModel(value: TextModelConfig | ImageModelConfig): string {
	const { model, ...rest } = value;
	const extras = Object.entries(rest)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `${k}=${v}`);
	return extras.length ? `${model}(${extras.join(",")})` : model;
}

/**
 * Reads the config for one pipeline invocation.
 *
 * Never throws. A missing key, an invalid value, or KV itself being unavailable
 * all fall back to the matching var and warn — a typo in the dashboard must not
 * take the service down. The vars are not re-validated; they are reviewed in the
 * repo.
 *
 * Deliberately not cached in module scope: module scope in a Durable Object
 * survives across invocations for the life of the instance, so a cached value
 * would freeze and dashboard edits would appear to do nothing. `cacheTtl` is the
 * cache.
 */
export async function resolveConfig(env: ConfigEnv): Promise<IrisConfig> {
	let values: Map<string, string | null>;

	try {
		values = await env.CONFIG.get(KEYS, { cacheTtl: CONFIG_CACHE_TTL });
	} catch (cause) {
		// A KV outage falls the whole config back to vars rather than failing the
		// request. Config is policy, not a dependency the pipeline cannot run without.
		console.warn(`config: KV read failed, using vars for every value:`, cause);
		values = new Map();
	}

	const resolved: Record<string, unknown> = {};
	const source: Record<string, ConfigSource> = {};

	for (const entry of FIELDS) {
		const raw = values.get(entry.key);

		if (raw === undefined || raw === null) {
			resolved[entry.field] = entry.fromVar(env);
			source[entry.field] = "var";
			continue;
		}

		const parsed = entry.schema.safeParse(entry.prepare(raw));
		if (!parsed.success) {
			// An invalid value is treated exactly like a missing one.
			console.warn(
				`config: KV key "${entry.key}" has an invalid value ${JSON.stringify(raw)}, falling back to ${entry.var}: ${parsed.error.issues[0]?.message ?? "invalid"}`
			);
			resolved[entry.field] = entry.fromVar(env);
			source[entry.field] = "var";
			continue;
		}

		resolved[entry.field] = parsed.data;
		source[entry.field] = "kv";
	}

	return { ...resolved, source } as IrisConfig;
}

/**
 * Which planner model this invocation actually calls.
 *
 * The vision model when one is configured, and `textModel` when it is not. The
 * choice does **not** depend on whether the request carries a reference image:
 * one model per deployment means one set of behaviour to tune and one prompt
 * that has to work, where branching on the request would mean two of each and
 * a class of bug that appears only once someone attaches an image.
 *
 * The empty-model case is checked explicitly rather than with a `?.` or a `||`
 * chain (AGENTS.md §7). "No vision model configured" is the ordinary state
 * before one is chosen, and it has to be distinguishable from a configured one
 * — the log line is where that distinction is answerable, so it is logged.
 */
export function plannerModelFor(config: IrisConfig): TextModelConfig {
	const vision = config.visionTextModel;

	if (vision === undefined || vision.model.trim().length === 0) {
		console.log("planner: no vision model configured, using text_model");
		return config.textModel;
	}

	return vision;
}

/**
 * The model that makes the research call, or `null` when retrieval is off.
 *
 * **Null rather than a throw.** An unconfigured knowledge base is a working
 * state, not an outage: every engine has to keep running before the AI Search
 * instances exist, and with `research_model` empty a run behaves exactly as it
 * did before Phase 2. That is what makes it possible to ship this work ahead of
 * the knowledge base content — which matters more on Iris than on Helios, since
 * no Iris instance exists yet at all.
 *
 * The empty case is checked explicitly rather than with a `?.` or a `||` chain
 * (AGENTS.md §7), and it is logged, because "retrieval was switched off" and
 * "retrieval ran and found nothing" are two different runs that would otherwise
 * be indistinguishable in the log.
 */
export function researchModelFor(config: IrisConfig): TextModelConfig | null {
	const research = config.researchModel;

	if (research === undefined || research.model.trim().length === 0) {
		console.log("research: no research model configured, skipping retrieval");
		return null;
	}

	return research;
}

/** One-line summary of the resolved config and where each value came from. */
export function describeConfig(config: IrisConfig): string {
	const parts = FIELDS.map((entry) => {
		const value = config[entry.field];
		return `${entry.key}=${entry.describe(value)} (${config.source[entry.field]})`;
	});
	return `config: ${parts.join(" ")}`;
}

/* ── Prompts ──────────────────────────────────────────────────────────────
 *
 * The same shape as the config above, for the same reason: a live store that
 * can be edited without a deploy, a committed fallback for when it has nothing
 * to say, and a record of which of the two actually answered.
 */

/** A prompt as this invocation will really send it, and where it came from. */
export interface ResolvedPrompt {
	text: string;
	/** `db` when the stored row supplied it, `code` when the committed builder did. */
	source: "db" | "code";
	/** The row's `updated_at`, and null whenever `source` is `code`. */
	updatedAt: string | null;
}

/**
 * Shorter than this and the row is not a prompt anyone meant to save.
 *
 * The guard earns its place because the failure it prevents is invisible: an
 * empty system prompt is not an error the model reports, it is a billed call
 * that returns something unusable. `upsertPrompt` already refuses to store blank
 * text, so this catches a row written around the repository — by hand in the
 * dashboard, say, or by a future writer that forgets.
 */
const MIN_PROMPT_LENGTH = 20;

/**
 * Reads one slot's prompt, falling back to the committed builder.
 *
 * **Read per invocation and never cached** — a Durable Object survives across
 * many requests, so a cached prompt would freeze and an edit in the playground
 * would appear to do nothing. This is ADR-0008 applied to a second store: the
 * same reason `resolveConfig` re-reads KV every time instead of memoising.
 *
 * **Never throws.** A missing row, an unusable row, and D1 being unavailable all
 * fall back to `fallback`. A prompt is policy, not a dependency the pipeline
 * cannot run without, and a database blip must not take the engine down.
 *
 * The three cases are handled separately on purpose (AGENTS.md §7). A missing
 * row is the expected state before a slot has been seeded and says nothing; a
 * row that exists but is unusable is a real problem and says so; a failed read
 * is a different problem again. One `?.` would have made all three look like the
 * first.
 */
export async function resolvePrompt(
	d1: IrisD1Db,
	slot: PromptSlot,
	fallback: string,
): Promise<ResolvedPrompt> {
	const fromCode: ResolvedPrompt = { text: fallback, source: "code", updatedAt: null };

	let row: Awaited<ReturnType<typeof getPrompt>>;
	try {
		row = await getPrompt(d1, slot);
	} catch (cause) {
		console.warn(`prompts: reading "${slot}" failed, using the committed prompt:`, cause);
		return fromCode;
	}

	// Silent, because it is expected: a slot that has not been seeded yet is
	// exactly what lets this roll out one prompt at a time.
	if (row === null) return fromCode;

	const stored = row.promptText.trim();
	if (stored.length < MIN_PROMPT_LENGTH) {
		console.warn(
			`prompts: stored "${slot}" is ${stored.length} characters, which is not a usable prompt — using the committed one instead.`,
		);
		return fromCode;
	}

	return { text: row.promptText, source: "db", updatedAt: row.updatedAt };
}

/** One-line summary of a resolved prompt, for the log beside `describeConfig`. */
export function describePrompt(slot: PromptSlot, prompt: ResolvedPrompt): string {
	const when = prompt.updatedAt ? `, updated ${prompt.updatedAt}` : "";
	return `prompt: ${slot}=${prompt.text.length}chars (${prompt.source}${when})`;
}
