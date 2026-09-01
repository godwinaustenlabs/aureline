import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
	CONFIG_CACHE_TTL,
	describeConfig,
	imageModelFor,
	plannerModelFor,
	resolveConfig,
	transportFor,
	type ConfigEnv,
} from "./config";

const VARS = {
	PLANNER_MODEL: "@cf/openai/gpt-oss-120b",
	VISION_PLANNER_MODEL: "@cf/meta/llama-3.2-11b-vision-instruct",
	IMAGE_MODEL: "@cf/black-forest-labs/flux-1-schnell",
	IMAGE_TO_IMAGE_MODEL: "@cf/black-forest-labs/flux-2-klein-9b",
	AI_GATEWAY_ID: "helios",
	RETENTION_LIMIT: "5",
	MAX_RETRIES: "2",
	MAX_RESUME_ATTEMPTS: "3",
};

const ALL_KEYS = [
	"text_model",
	"vision_planner_model",
	"image_model",
	"image_to_image_model",
	"max_retries",
	"retention_limit",
	"max_resume_attempts",
];

/**
 * Builds a fake `Env` whose CONFIG namespace returns the given KV values.
 * Only the fields `resolveConfig` touches are present, so this needs no Worker
 * runtime and makes no model calls.
 */
function fakeEnv(
	kv: Record<string, string> = {},
	// `string | undefined`, not `Partial<typeof VARS>`: a var missing from
	// wrangler.jsonc is a real runtime case that `numberFromVar` warns and falls
	// back on, and the test for it used to force `undefined` through with a cast.
	overrides: Partial<Record<keyof typeof VARS, string | undefined>> = {},
) {
	const get = vi.fn(async (keys: string[]) => {
		return new Map(keys.map((key) => [key, kv[key] ?? null]));
	});
	// No cast: `resolveConfig` takes `ConfigEnv`, which is the five vars and the
	// one KV method this file actually reads (AGENTS.md §4).
	const env: ConfigEnv = { ...VARS, ...overrides, CONFIG: { get } };
	return { env, get };
}

/** The shape actually stored in the HELIOS_CONFIG namespace. */
const FULL_KV = {
	text_model: '{ "model": "@cf/openai/gpt-oss-120b", "temperature": 1 }',
	vision_planner_model: '{ "model": "@cf/meta/llama-3.2-11b-vision-instruct" }',
	image_model:
		'{ "model": "@cf/black-forest-labs/flux-1-schnell", "width": 1024, "height": 1024, "steps": 4 }',
	image_to_image_model: '{ "model": "@cf/black-forest-labs/flux-2-klein-9b", "transport": "multipart" }',
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
			visionTextModel: { model: "@cf/meta/llama-3.2-11b-vision-instruct" },
			imageModel: {
				model: "@cf/black-forest-labs/flux-1-schnell",
				width: 1024,
				height: 1024,
				steps: 4,
			},
			imageToImageModel: {
				model: "@cf/black-forest-labs/flux-2-klein-9b",
				transport: "multipart",
			},
			maxRetries: 3,
			retentionLimit: 10,
			maxResumeAttempts: 4,
			source: {
				textModel: "kv",
				visionTextModel: "kv",
				imageModel: "kv",
				imageToImageModel: "kv",
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
			visionTextModel: { model: VARS.VISION_PLANNER_MODEL },
			imageModel: { model: VARS.IMAGE_MODEL },
			imageToImageModel: { model: VARS.IMAGE_TO_IMAGE_MODEL, transport: "multipart" },
			maxRetries: 2,
			retentionLimit: 5,
			maxResumeAttempts: 3,
			source: {
				textModel: "var",
				visionTextModel: "var",
				imageModel: "var",
				imageToImageModel: "var",
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
		const { env } = fakeEnv({}, { MAX_RETRIES: undefined });

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
				"vision_planner_model=@cf/meta/llama-3.2-11b-vision-instruct (kv) " +
				"image_model=@cf/black-forest-labs/flux-1-schnell(width=1024,height=1024,steps=4) (kv) " +
				"image_to_image_model=@cf/black-forest-labs/flux-2-klein-9b(transport=multipart) (kv) " +
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

describe("plannerModelFor", () => {
	it("uses the vision model when one is configured", async () => {
		const config = await resolveConfig(fakeEnv(FULL_KV).env);

		expect(plannerModelFor(config).model).toBe("@cf/meta/llama-3.2-11b-vision-instruct");
	});

	it("carries the vision model's own temperature, not the text model's", async () => {
		// The failure this catches is quiet and expensive: reading the id from one
		// model and the temperature from the other tunes a model that is not the
		// one being called, on every billed request.
		const { env } = fakeEnv({
			...FULL_KV,
			vision_planner_model:
				'{ "model": "@cf/meta/llama-3.2-11b-vision-instruct", "temperature": 0.3 }',
		});

		expect(plannerModelFor(await resolveConfig(env))).toEqual({
			model: "@cf/meta/llama-3.2-11b-vision-instruct",
			temperature: 0.3,
		});
	});

	it("falls back to the text model when the vision var is empty", async () => {
		// The off switch. An empty var is how this is turned off without a deploy,
		// so it has to resolve to the text model rather than to an empty model id
		// that would reach `ai.run` and fail there.
		const { vision_planner_model: _absent, ...rest } = FULL_KV;
		const { env } = fakeEnv(rest, { VISION_PLANNER_MODEL: "" });

		expect(plannerModelFor(await resolveConfig(env))).toEqual({
			model: "@cf/openai/gpt-oss-120b",
			temperature: 1,
		});
	});

	it("falls back to the text model when the vision var is absent entirely", async () => {
		const { vision_planner_model: _absent, ...rest } = FULL_KV;
		const { env } = fakeEnv(rest, { VISION_PLANNER_MODEL: undefined });

		expect(plannerModelFor(await resolveConfig(env)).model).toBe("@cf/openai/gpt-oss-120b");
	});

	it("falls back to the var, with a warning, when KV holds an invalid vision model", async () => {
		const { env } = fakeEnv({ ...FULL_KV, vision_planner_model: '{ "temperature": 0.5 }' });

		const config = await resolveConfig(env);

		expect(config.source.visionTextModel).toBe("var");
		expect(config.visionTextModel).toEqual({ model: VARS.VISION_PLANNER_MODEL });
		expect(warn).toHaveBeenCalled();
	});
});

describe("image_to_image_model", () => {
	it("resolves from KV, transport included", async () => {
		const config = await resolveConfig(fakeEnv(FULL_KV).env);

		expect(config.imageToImageModel).toEqual({
			model: "@cf/black-forest-labs/flux-2-klein-9b",
			transport: "multipart",
		});
		expect(config.source.imageToImageModel).toBe("kv");
	});

	it("falls back to the var, and the var says multipart", async () => {
		// The var has to carry `transport` itself. This model is only ever reached
		// through the multipart helper, so a fallback that resolved to "json" would
		// describe a call the klein family rejects outright.
		const { image_to_image_model: _absent, ...rest } = FULL_KV;
		const { env } = fakeEnv(rest);

		const config = await resolveConfig(env);

		expect(config.imageToImageModel).toEqual({
			model: VARS.IMAGE_TO_IMAGE_MODEL,
			transport: "multipart",
		});
		expect(config.source.imageToImageModel).toBe("var");
	});

	it("falls back to the var, with a warning, when KV holds an unknown transport", async () => {
		const { env } = fakeEnv({
			...FULL_KV,
			image_to_image_model: '{ "model": "@cf/black-forest-labs/flux-2-klein-9b", "transport": "grpc" }',
		});

		const config = await resolveConfig(env);

		expect(config.source.imageToImageModel).toBe("var");
		expect(warn).toHaveBeenCalled();
	});
});

describe("transportFor", () => {
	it("reads an absent transport as json, which is what every existing KV value means", async () => {
		const { image_model: _absent, ...rest } = FULL_KV;
		const config = await resolveConfig(fakeEnv(rest).env);

		expect(config.imageModel.transport).toBeUndefined();
		expect(transportFor(config.imageModel)).toBe("json");
	});

	it("reads a stated transport as itself", async () => {
		const config = await resolveConfig(fakeEnv(FULL_KV).env);

		expect(transportFor(config.imageToImageModel)).toBe("multipart");
	});

	it("lets KV move the text-only path onto a multipart model without a code change", async () => {
		// This is the whole point of the field. Once klein is confirmed to accept
		// zero input images, making it the no-reference path is this KV edit and
		// nothing else.
		const { env } = fakeEnv({
			...FULL_KV,
			image_model: '{ "model": "@cf/black-forest-labs/flux-2-klein-9b", "transport": "multipart" }',
		});

		const config = await resolveConfig(env);

		expect(transportFor(config.imageModel)).toBe("multipart");
		expect(config.source.imageModel).toBe("kv");
	});
});

describe("imageModelFor", () => {
	it("uses the text-to-image model when no reference image was uploaded", async () => {
		const config = await resolveConfig(fakeEnv(FULL_KV).env);

		expect(imageModelFor(config, false).model).toBe("@cf/black-forest-labs/flux-1-schnell");
	});

	it("uses the image-to-image model when one was", async () => {
		const config = await resolveConfig(fakeEnv(FULL_KV).env);

		expect(imageModelFor(config, true).model).toBe("@cf/black-forest-labs/flux-2-klein-9b");
	});

	it("refuses, rather than falling back, when a reference arrives and no i2i model is configured", async () => {
		// The alternative — quietly using `imageModel` — bills the image model for
		// a result that ignored the upload and leaves an audit row that looks
		// completely normal. Nothing downstream could ever tell that apart from a
		// working run, which is why this throws before anything spends money.
		const { image_to_image_model: _absent, ...rest } = FULL_KV;
		const { env } = fakeEnv(rest, { IMAGE_TO_IMAGE_MODEL: "" });
		const config = await resolveConfig(env);

		expect(() => imageModelFor(config, true)).toThrow(/no image_to_image_model is configured/);
		// And the no-reference path is unaffected by the same missing config.
		expect(imageModelFor(config, false).model).toBe("@cf/black-forest-labs/flux-1-schnell");
	});
});
