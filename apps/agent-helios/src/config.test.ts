import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CONFIG_CACHE_TTL, describeConfig, resolveConfig } from "./config";

const VARS = {
	PLANNER_MODEL: "@cf/openai/gpt-oss-120b",
	IMAGE_MODEL: "@cf/black-forest-labs/flux-1-schnell",
	AI_GATEWAY_ID: "helios",
	RETENTION_LIMIT: "5",
	MAX_RETRIES: "2",
	MAX_RESUME_ATTEMPTS: "3",
};

const ALL_KEYS = [
	"text_model",
	"image_model",
	"max_retries",
	"retention_limit",
	"max_resume_attempts",
];

/**
 * Builds a fake `Env` whose CONFIG namespace returns the given KV values.
 * Only the fields `resolveConfig` touches are present, so this needs no Worker
 * runtime and makes no model calls.
 */
function fakeEnv(kv: Record<string, string> = {}, overrides: Partial<typeof VARS> = {}) {
	const get = vi.fn(async (keys: string[]) => {
		return new Map(keys.map((key) => [key, kv[key] ?? null]));
	});
	return { env: { ...VARS, ...overrides, CONFIG: { get } } as unknown as Env, get };
}

/** The shape actually stored in the HELIOS_CONFIG namespace. */
const FULL_KV = {
	text_model: '{ "model": "@cf/openai/gpt-oss-120b", "temperature": 1 }',
	image_model:
		'{ "model": "@cf/black-forest-labs/flux-1-schnell", "width": 1024, "height": 1024, "steps": 4 }',
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

		expect(config).toEqual({
			textModel: { model: "@cf/openai/gpt-oss-120b", temperature: 1 },
			imageModel: {
				model: "@cf/black-forest-labs/flux-1-schnell",
				width: 1024,
				height: 1024,
				steps: 4,
			},
			maxRetries: 3,
			retentionLimit: 10,
			maxResumeAttempts: 4,
			source: {
				textModel: "kv",
				imageModel: "kv",
				maxRetries: "kv",
				retentionLimit: "kv",
				maxResumeAttempts: "kv",
			},
		});
		expect(warn).not.toHaveBeenCalled();
	});

	it("reads every key in one call, with the cache TTL", async () => {
		const { env, get } = fakeEnv(FULL_KV);

		await resolveConfig(env);

		expect(get).toHaveBeenCalledTimes(1);
		expect(get).toHaveBeenCalledWith(ALL_KEYS, { cacheTtl: CONFIG_CACHE_TTL });
		expect(CONFIG_CACHE_TTL).toBe(60);
	});

	it("accepts a bare model id, since the dashboard is hand-edited", async () => {
		const { env } = fakeEnv({ ...FULL_KV, text_model: "@cf/meta/llama-3.1-8b-instruct" });

		const config = await resolveConfig(env);

		expect(config.textModel).toEqual({ model: "@cf/meta/llama-3.1-8b-instruct" });
		expect(config.source.textModel).toBe("kv");
		expect(warn).not.toHaveBeenCalled();
	});

	it("ignores fields it does not know about rather than rejecting the value", async () => {
		// A field added in the dashboard ahead of the code that reads it.
		const { env } = fakeEnv({
			...FULL_KV,
			text_model: '{ "model": "@cf/openai/gpt-oss-120b", "top_p": 0.9 }',
		});

		const config = await resolveConfig(env);

		expect(config.textModel).toEqual({ model: "@cf/openai/gpt-oss-120b" });
		expect(config.source.textModel).toBe("kv");
	});

	it("falls back and warns on malformed JSON", async () => {
		const { env } = fakeEnv({ ...FULL_KV, image_model: '{ "model": "x", ' });

		const config = await resolveConfig(env);

		expect(config.imageModel).toEqual({ model: VARS.IMAGE_MODEL });
		expect(config.source.imageModel).toBe("var");
		expect(warn).toHaveBeenCalledOnce();
	});

	it("falls back when the JSON parses but has no model id", async () => {
		const { env } = fakeEnv({ ...FULL_KV, text_model: '{ "temperature": 0.5 }' });

		const config = await resolveConfig(env);

		expect(config.textModel).toEqual({ model: VARS.PLANNER_MODEL });
		expect(config.source.textModel).toBe("var");
	});

	it("falls back when a tuning field is out of range", async () => {
		const { env } = fakeEnv({
			...FULL_KV,
			text_model: '{ "model": "@cf/openai/gpt-oss-120b", "temperature": 9 }',
		});

		const config = await resolveConfig(env);

		expect(config.source.textModel).toBe("var");
		expect(warn).toHaveBeenCalledOnce();
	});

	it("falls back to the var for an absent key and leaves the others on KV", async () => {
		const { image_model: _absent, ...rest } = FULL_KV;
		const { env } = fakeEnv(rest);

		const config = await resolveConfig(env);

		expect(config.imageModel).toEqual({ model: VARS.IMAGE_MODEL });
		expect(config.source.imageModel).toBe("var");
		expect(config.source.textModel).toBe("kv");
		expect(config.source.maxRetries).toBe("kv");
	});

	it("falls back and warns when max_retries is not a number", async () => {
		const { env } = fakeEnv({ ...FULL_KV, max_retries: "abc" });

		const config = await resolveConfig(env);

		expect(config.maxRetries).toBe(2);
		expect(config.source.maxRetries).toBe("var");
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]?.[0]).toContain("max_retries");
	});

	it.each(["0", "99"])("falls back when max_retries is out of range (%s)", async (value) => {
		const { env } = fakeEnv({ ...FULL_KV, max_retries: value });

		const config = await resolveConfig(env);

		expect(config.maxRetries).toBe(2);
		expect(config.source.maxRetries).toBe("var");
	});

	it("rejects a whitespace-only model id", async () => {
		const { env } = fakeEnv({ ...FULL_KV, text_model: "   " });

		const config = await resolveConfig(env);

		expect(config.textModel).toEqual({ model: VARS.PLANNER_MODEL });
		expect(config.source.textModel).toBe("var");
		expect(warn).toHaveBeenCalledOnce();
	});

	it("falls every value back to its var when the KV read itself fails", async () => {
		const { env } = fakeEnv();
		(env.CONFIG.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("KV unavailable"));

		const config = await resolveConfig(env);

		expect(config).toEqual({
			textModel: { model: VARS.PLANNER_MODEL },
			imageModel: { model: VARS.IMAGE_MODEL },
			maxRetries: 2,
			retentionLimit: 5,
			maxResumeAttempts: 3,
			source: {
				textModel: "var",
				imageModel: "var",
				maxRetries: "var",
				retentionLimit: "var",
				maxResumeAttempts: "var",
			},
		});
		expect(warn).toHaveBeenCalledOnce();
	});

	it("never throws, even when a numeric var is missing from wrangler.jsonc", async () => {
		// Unreachable while `wrangler types` keeps the var typed, but this runs
		// outside runPipeline's try block, so a throw here would escape as a 500.
		const { env } = fakeEnv({}, { MAX_RETRIES: undefined as unknown as string });

		const config = await resolveConfig(env);

		expect(config.maxRetries).toBe(2);
		expect(config.source.maxRetries).toBe("var");
	});
});

describe("describeConfig", () => {
	it("names every value, its tuning fields, and where it came from", async () => {
		const { retention_limit: _absent, ...rest } = FULL_KV;
		const { env } = fakeEnv(rest);

		const line = describeConfig(await resolveConfig(env));

		expect(line).toBe(
			"config: text_model=@cf/openai/gpt-oss-120b(temperature=1) (kv) " +
				"image_model=@cf/black-forest-labs/flux-1-schnell(width=1024,height=1024,steps=4) (kv) " +
				"max_retries=3 (kv) retention_limit=5 (var) max_resume_attempts=4 (kv)"
		);
	});

	it("names the resume cap too, so a raised limit is visible in the log", async () => {
		const { env } = fakeEnv({ ...FULL_KV, max_resume_attempts: "9" });

		expect(describeConfig(await resolveConfig(env))).toContain("max_resume_attempts=9 (kv)");
	});
});

describe("max_resume_attempts", () => {
	it("falls back to the var when the value is out of range", async () => {
		// A cap on how many times one concept may spend the image model, so an
		// unbounded dashboard value must not be accepted.
		const { env } = fakeEnv({ ...FULL_KV, max_resume_attempts: "500" });

		const config = await resolveConfig(env);

		expect(config.maxResumeAttempts).toBe(3);
		expect(config.source.maxResumeAttempts).toBe("var");
		expect(warn).toHaveBeenCalledOnce();
	});

	it("falls back to the var when the key is absent", async () => {
		const { max_resume_attempts: _absent, ...rest } = FULL_KV;
		const { env } = fakeEnv(rest);

		const config = await resolveConfig(env);

		expect(config.maxResumeAttempts).toBe(3);
		expect(config.source.maxResumeAttempts).toBe("var");
	});
});
