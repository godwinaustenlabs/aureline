import { z } from "zod";
import type { HeliosD1Db } from "./db/client";
import type { PromptSlot } from "./db/schema.d1";
import { getPrompt } from "./repository/prompts.repository";

/**
 * Runtime config resolved from the `CONFIG` KV namespace, with the
 * `wrangler.jsonc` vars as committed fallbacks.
 *
 * KV holds the live value and is edited by hand from the Cloudflare dashboard
 * (namespace "HELIOS_CONFIG"); this app only ever reads it. There is one
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
export interface HeliosConfig {
	textModel: TextModelConfig;
	imageModel: ImageModelConfig;
	maxRetries: number;
	retentionLimit: number;
	/**
	 * How many times one brief may be resumed. Counts resumes only, so 3 means
	 * an original plus three retries. Every retry spends the image model, so this
	 * is the ceiling on what a single concept can cost.
	 */
	maxResumeAttempts: number;
	/** Per-field provenance, for the log line. */
	source: Record<"textModel" | "imageModel" | "maxRetries" | "retentionLimit" | "maxResumeAttempts", ConfigSource>;
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
	IMAGE_MODEL: string;
	MAX_RETRIES?: string;
	RETENTION_LIMIT?: string;
	MAX_RESUME_ATTEMPTS?: string;
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
export async function resolveConfig(env: ConfigEnv): Promise<HeliosConfig> {
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

	return { ...resolved, source } as HeliosConfig;
}

/** One-line summary of the resolved config and where each value came from. */
export function describeConfig(config: HeliosConfig): string {
	const parts = FIELDS.map((entry) => {
		const value = config[entry.field];
		return `${entry.key}=${entry.describe(value)} (${config.source[entry.field]})`;
	});
	return `config: ${parts.join(" ")}`;
}

/* ── Prompts ───────────────────────────────────────────────────────────
 *
 * The same shape as the config above, for the same reason: a live store that
 * can be edited without a deploy, a committed fallback for when it has nothing
 * to say, and a record of which of the two actually answered.
 *
 * Deliberately identical to Iris's, down to the wording, so the two engines
 * resolve prompts by the same code read the same way.
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
	d1: HeliosD1Db,
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
