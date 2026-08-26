import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CONFIG_CACHE_TTL, describeConfig, resolveConfig } from "./config";

/**
 * Adapted from `apps/agent-helios/src/config.test.ts`.
 *
 * **Every `text_model` case was deleted rather than adjusted.** Atlas has no
 * text call and therefore no such key (atlas-02 decision 7), and a passing test
 * for a dead key is exactly what would make one look intentional.
 */

const VARS = {
	IMAGE_MODEL: "@cf/black-forest-labs/flux-2-klein-9b",
	AI_GATEWAY_ID: "atlas",
	RETENTION_LIMIT: "5",
	MAX_RETRIES: "2",
	MAX_RESUME_ATTEMPTS: "3",
};

const ALL_KEYS = ["image_model", "max_retries", "retention_limit", "max_resume_attempts"];

/**
 * Builds a fake `Env` whose CONFIG namespace returns the given KV values.
 * Only the fields `resolveConfig` touches are present, so this needs no Worker
 * runtime and makes no model calls.
 */
function fakeEnv(kv: Record<string, string> = {}, overrides: Partial<typeof VARS> = {}) {
	const get = vi.fn(async (keys: string[]) => new Map(keys.map((key) => [key, kv[key] ?? null])));
	return { env: { ...VARS, ...overrides, CONFIG: { get } } as unknown as Env, get };
}

/** The shape actually stored in the ATLAS_CONFIG namespace. */
const FULL_KV = {
	image_model: '{ "model": "@cf/black-forest-labs/flux-2-klein-9b", "steps": 4 }',
	max_retries: "3",
	retention_limit: "10",
	max_resume_attempts: "4",
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("resolveConfig", () => {
	it("takes every value from KV when all the keys are present and valid", async () => {
		const { env } = fakeEnv(FULL_KV);

		const config = await resolveConfig(env);

		expect(config.imageModel).toEqual({ model: "@cf/black-forest-labs/flux-2-klein-9b", steps: 4 });
		expect(config.maxRetries).toBe(3);
		expect(config.retentionLimit).toBe(10);
		expect(config.maxResumeAttempts).toBe(4);
		expect(config.source).toEqual({
			imageModel: "kv",
			maxRetries: "kv",
			retentionLimit: "kv",
			maxResumeAttempts: "kv",
		});
	});

	it("asks for exactly the four keys, and never for text_model", async () => {
		const { env, get } = fakeEnv(FULL_KV);

		await resolveConfig(env);

		expect(get).toHaveBeenCalledWith(ALL_KEYS, { cacheTtl: CONFIG_CACHE_TTL });
		expect(get.mock.calls[0]![0]).not.toContain("text_model");
	});

	it("reads KV once per invocation, in one batched call", async () => {
		const { env, get } = fakeEnv(FULL_KV);

		await resolveConfig(env);

		expect(get).toHaveBeenCalledTimes(1);
	});

	it("falls back to every var on a fresh clone with an empty store", async () => {
		const { env } = fakeEnv({});

		const config = await resolveConfig(env);

		// This is correct, not a failure. It is what the fallbacks are for.
		expect(config.imageModel).toEqual({ model: VARS.IMAGE_MODEL });
		expect(config.maxRetries).toBe(2);
		expect(config.retentionLimit).toBe(5);
		expect(config.maxResumeAttempts).toBe(3);
		expect(Object.values(config.source)).toEqual(["var", "var", "var", "var"]);
	});

	it("falls back per field, not all-or-nothing", async () => {
		const { env } = fakeEnv({ retention_limit: "42" });

		const config = await resolveConfig(env);

		expect(config.retentionLimit).toBe(42);
		expect(config.source.retentionLimit).toBe("kv");
		expect(config.source.imageModel).toBe("var");
	});

	it("accepts a bare model id, because the dashboard is hand-edited", async () => {
		const { env } = fakeEnv({ image_model: "  @cf/some/other-model  " });

		const config = await resolveConfig(env);

		expect(config.imageModel).toEqual({ model: "@cf/some/other-model" });
		expect(config.source.imageModel).toBe("kv");
	});

	it("strips unknown fields inside the model object rather than rejecting it", async () => {
		// A field added in the dashboard ahead of the code that reads it should be
		// ignored, not invalidate the whole value.
		const { env } = fakeEnv({ image_model: '{ "model": "m", "guidance": 7 }' });

		const config = await resolveConfig(env);

		expect(config.imageModel).toEqual({ model: "m" });
		expect(config.source.imageModel).toBe("kv");
	});

	it("falls back on malformed JSON in a model key", async () => {
		const { env } = fakeEnv({ image_model: '{ "model": ' });

		const config = await resolveConfig(env);

		expect(config.imageModel).toEqual({ model: VARS.IMAGE_MODEL });
		expect(config.source.imageModel).toBe("var");
		expect(warn).toHaveBeenCalled();
	});

	it("falls back on a model object with no model id", async () => {
		const { env } = fakeEnv({ image_model: '{ "steps": 4 }' });

		expect((await resolveConfig(env)).source.imageModel).toBe("var");
	});

	it.each([
		["below the minimum", "0"],
		["above the maximum", "6"],
		["not a number", "lots"],
		["fractional", "2.5"],
		["empty", ""],
	])("falls back when max_retries is %s", async (_label, value) => {
		const { env } = fakeEnv({ max_retries: value });

		const config = await resolveConfig(env);

		expect(config.maxRetries).toBe(2);
		expect(config.source.maxRetries).toBe("var");
	});

	it("caps max_resume_attempts at 20, so a fat-fingered edit cannot authorise an unbounded bill", async () => {
		const { env } = fakeEnv({ max_resume_attempts: "5000" });

		const config = await resolveConfig(env);

		expect(config.maxResumeAttempts).toBe(3);
		expect(config.source.maxResumeAttempts).toBe("var");
	});

	it("caps retention_limit at 100", async () => {
		const { env } = fakeEnv({ retention_limit: "101" });

		expect((await resolveConfig(env)).source.retentionLimit).toBe("var");
	});

	it("never throws when KV itself is down", async () => {
		// Config is policy, not a dependency the pipeline cannot run without.
		const env = {
			...VARS,
			CONFIG: { get: vi.fn(async () => { throw new Error("KV unavailable"); }) },
		} as unknown as Env;

		const config = await resolveConfig(env);

		expect(config.imageModel).toEqual({ model: VARS.IMAGE_MODEL });
		expect(Object.values(config.source)).toEqual(["var", "var", "var", "var"]);
		expect(warn).toHaveBeenCalled();
	});

	it("never throws when a fallback var is itself broken", async () => {
		// Only reachable if wrangler.jsonc is wrong. `resolveConfig` runs outside
		// runPipeline's try block, so throwing here would escape as an opaque 500
		// instead of a settled result.
		const { env } = fakeEnv({}, { RETENTION_LIMIT: "not-a-number" });

		const config = await resolveConfig(env);

		expect(config.retentionLimit).toBe(5);
		expect(warn).toHaveBeenCalled();
	});

	it("treats a null KV value exactly like a missing key", async () => {
		const env = {
			...VARS,
			CONFIG: { get: vi.fn(async (keys: string[]) => new Map(keys.map((k) => [k, null]))) },
		} as unknown as Env;

		expect((await resolveConfig(env)).source.imageModel).toBe("var");
	});
});

describe("describeConfig", () => {
	it("names every value and where it came from", async () => {
		const { env } = fakeEnv(FULL_KV);

		const line = describeConfig(await resolveConfig(env));

		expect(line).toBe(
			"config: image_model=@cf/black-forest-labs/flux-2-klein-9b(steps=4) (kv) " +
				"max_retries=3 (kv) retention_limit=10 (kv) max_resume_attempts=4 (kv)",
		);
	});

	it("reports (var) four times on a fresh clone", async () => {
		const { env } = fakeEnv({});

		const line = describeConfig(await resolveConfig(env));

		expect(line.match(/\(var\)/g)).toHaveLength(4);
	});

	it("never mentions text_model", async () => {
		const { env } = fakeEnv(FULL_KV);

		expect(describeConfig(await resolveConfig(env))).not.toContain("text_model");
	});
});
