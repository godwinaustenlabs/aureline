import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
	CONFIG_CACHE_TTL,
	describeConfig,
	plannerModelFor,
	researchModelFor,
	resolveConfig,
	type ConfigEnv,
} from "./config";

const VARS = {
	PLANNER_MODEL: "@cf/openai/gpt-oss-120b",
	VISION_PLANNER_MODEL: "@cf/meta/llama-3.2-11b-vision-instruct",
	IMAGE_MODEL: "@cf/black-forest-labs/flux-2-klein-9b",
	AI_GATEWAY_ID: "iris",
	RETENTION_LIMIT: "5",
	MAX_RETRIES: "2",
	MAX_RESUME_ATTEMPTS: "3",
	// Set here, unlike `test-env.ts` where it is deliberately empty: this file's
	// subject is config resolution itself, so the interesting case is a research
	// model that resolves to something. `researchModelFor`'s off switch has its
	// own tests below, where emptiness is the subject rather than the backdrop.
	RESEARCH_MODEL: "@cf/meta/llama-3.2-11b-vision-instruct",
	MAX_TOOL_ITERATIONS: "3",
	MAX_SEARCH_RESULTS: "5",
	MIN_CHUNK_CHARS: "200",
	SEARCH_MATCH_THRESHOLD: "0.5",
	AI_SEARCH_QUERY_REWRITE: "false",
};

const ALL_KEYS = [
	"text_model",
	"vision_planner_model",
	"image_model",
	"max_retries",
	"retention_limit",
	"max_resume_attempts",
	"research_model",
	"max_tool_iterations",
	"max_search_results",
	"min_chunk_chars",
	"search_match_threshold",
	"ai_search_query_rewrite",
];

/**
 * Builds a `ConfigEnv` whose CONFIG namespace returns the given KV values.
 *
 * `ConfigEnv` is exactly what `resolveConfig` reads, so this is a real value of
 * the parameter type rather than a fake asserted into one — no cast anywhere in
 * this file. It needs no Worker runtime and makes no model calls.
 */
function fakeEnv(
	kv: Record<string, string> = {},
	// `string | undefined` rather than `Partial<typeof VARS>`: a test that drops a
	// var has to be able to pass `undefined` explicitly, and `numberFromVar`
	// warning on a missing var is real behaviour worth covering.
	overrides: Partial<Record<keyof typeof VARS, string | undefined>> = {},
) {
	const get = vi.fn(async (keys: string[]) => {
		return new Map(keys.map((key) => [key, kv[key] ?? null]));
	});
	// No cast: `ConfigEnv` is exactly what `resolveConfig` reads, and `CONFIG` is
	// narrowed to the one method it calls.
	const env: ConfigEnv = { ...VARS, ...overrides, CONFIG: { get } };
	return { env, get };
}

/** The shape actually stored in the IRIS_CONFIG namespace. */
const FULL_KV = {
	text_model: '{ "model": "@cf/openai/gpt-oss-120b", "temperature": 1 }',
	vision_planner_model: '{ "model": "@cf/meta/llama-3.2-11b-vision-instruct" }',
	image_model:
		'{ "model": "@cf/black-forest-labs/flux-2-klein-9b", "width": 1024, "height": 1024, "steps": 4 }',
	max_retries: "3",
	retention_limit: "10",
	max_resume_attempts: "4",
	research_model: '{ "model": "@cf/meta/llama-3.2-11b-vision-instruct" }',
	max_tool_iterations: "2",
	max_search_results: "8",
	min_chunk_chars: "150",
	search_match_threshold: "0.6",
	ai_search_query_rewrite: "true",
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
				model: "@cf/black-forest-labs/flux-2-klein-9b",
				width: 1024,
				height: 1024,
				steps: 4,
			},
			maxRetries: 3,
			retentionLimit: 10,
			maxResumeAttempts: 4,
			researchModel: { model: "@cf/meta/llama-3.2-11b-vision-instruct" },
			maxToolIterations: 2,
			maxSearchResults: 8,
			minChunkChars: 150,
			searchMatchThreshold: 0.6,
			queryRewrite: true,
			source: {
				textModel: "kv",
				visionTextModel: "kv",
				imageModel: "kv",
				maxRetries: "kv",
				retentionLimit: "kv",
				maxResumeAttempts: "kv",
				researchModel: "kv",
				maxToolIterations: "kv",
				maxSearchResults: "kv",
				minChunkChars: "kv",
				searchMatchThreshold: "kv",
				queryRewrite: "kv",
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
		const { env, get } = fakeEnv();
		get.mockRejectedValue(new Error("KV unavailable"));

		const config = await resolveConfig(env);

		expect(config).toEqual({
			textModel: { model: VARS.PLANNER_MODEL },
			visionTextModel: { model: VARS.VISION_PLANNER_MODEL },
			imageModel: { model: VARS.IMAGE_MODEL },
			maxRetries: 2,
			retentionLimit: 5,
			maxResumeAttempts: 3,
			researchModel: { model: VARS.RESEARCH_MODEL },
			maxToolIterations: 3,
			maxSearchResults: 5,
			minChunkChars: 200,
			searchMatchThreshold: 0.5,
			queryRewrite: false,
			source: {
				textModel: "var",
				visionTextModel: "var",
				imageModel: "var",
				maxRetries: "var",
				retentionLimit: "var",
				maxResumeAttempts: "var",
				researchModel: "var",
				maxToolIterations: "var",
				maxSearchResults: "var",
				minChunkChars: "var",
				searchMatchThreshold: "var",
				queryRewrite: "var",
			},
		});
		// Still exactly one: the KV outage warns once for the whole config, and
		// none of the six new vars is unusable enough to add a second.
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
				"image_model=@cf/black-forest-labs/flux-2-klein-9b(width=1024,height=1024,steps=4) (kv) " +
				"max_retries=3 (kv) retention_limit=5 (var) max_resume_attempts=4 (kv) " +
				"research_model=@cf/meta/llama-3.2-11b-vision-instruct (kv) " +
				"max_tool_iterations=2 (kv) max_search_results=8 (kv) min_chunk_chars=150 (kv) " +
				"search_match_threshold=0.6 (kv) ai_search_query_rewrite=true (kv)"
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

describe("researchModelFor", () => {
	it("returns the configured research model", async () => {
		const { env } = fakeEnv(FULL_KV);

		expect(researchModelFor(await resolveConfig(env))).toEqual({
			model: "@cf/meta/llama-3.2-11b-vision-instruct",
		});
	});

	it("returns null when the KV value is empty, without warning", async () => {
		// `research_model: ""` is the off switch and it has to work from KV with no
		// deploy. Under the strict `TextModelSchema` it would fail `min(1)`, warn on
		// every invocation, and fall back to RESEARCH_MODEL — so the key meant to
		// turn retrieval OFF would turn it ON. This is that regression.
		const { env } = fakeEnv({ ...FULL_KV, research_model: "" });

		const config = await resolveConfig(env);

		expect(config.researchModel).toEqual({ model: "" });
		expect(config.source.researchModel).toBe("kv");
		expect(researchModelFor(config)).toBeNull();
		expect(warn).not.toHaveBeenCalled();
	});

	it("returns null when the var is empty, which is what wrangler.jsonc commits", async () => {
		// Iris ships with RESEARCH_MODEL empty because no Iris AI Search instance
		// exists. This is the state every deployed run is in until one does.
		const { env } = fakeEnv({}, { RESEARCH_MODEL: "" });

		expect(researchModelFor(await resolveConfig(env))).toBeNull();
	});

	it("returns null when the var is absent entirely", async () => {
		const { env } = fakeEnv({}, { RESEARCH_MODEL: undefined });

		expect(researchModelFor(await resolveConfig(env))).toBeNull();
	});

	it("treats a whitespace-only model id as off", async () => {
		const { env } = fakeEnv({ ...FULL_KV, research_model: "   " });

		expect(researchModelFor(await resolveConfig(env))).toBeNull();
	});
});

describe("Iris has no classifier key", () => {
	it("does not read classifier_model from KV", async () => {
		// Classification happens once in Helios and Iris reads the answer, so a
		// classifier key here would be permanently dead rather than awaiting a
		// caller. Asserted on the actual KV read so the omission is deliberate and
		// stays deliberate.
		const { env, get } = fakeEnv(FULL_KV);

		await resolveConfig(env);

		expect(get.mock.calls[0][0]).not.toContain("classifier_model");
	});
});

describe("ai_search_query_rewrite", () => {
	it.each([
		["true", true],
		["1", true],
		["yes", true],
		["false", false],
		["0", false],
		["no", false],
		["TRUE", true],
		["  False  ", false],
	])("reads %j as %j", async (raw, expected) => {
		const { env } = fakeEnv({ ...FULL_KV, ai_search_query_rewrite: raw });

		expect((await resolveConfig(env)).queryRewrite).toBe(expected);
	});

	it("falls back to false on a value that is not a boolean", async () => {
		const { env } = fakeEnv({ ...FULL_KV, ai_search_query_rewrite: "maybe" });

		const config = await resolveConfig(env);

		expect(config.queryRewrite).toBe(false);
		expect(config.source.queryRewrite).toBe("var");
		expect(warn).toHaveBeenCalled();
	});

	it("does not read the string \"false\" as true", async () => {
		// `Boolean(raw)` and `raw !== ""` both would, which is why neither is used:
		// the key set to turn a billed feature off would turn it on.
		const { env } = fakeEnv({ ...FULL_KV, ai_search_query_rewrite: "false" });

		expect((await resolveConfig(env)).queryRewrite).toBe(false);
	});

	it("falls back to the var when the var itself is not a boolean", async () => {
		const { env } = fakeEnv({}, { AI_SEARCH_QUERY_REWRITE: "on" });

		expect((await resolveConfig(env)).queryRewrite).toBe(false);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("AI_SEARCH_QUERY_REWRITE"));
	});
});

describe("the numeric research keys", () => {
	it("accepts zero for min_chunk_chars, because zero is a real setting", async () => {
		const { env } = fakeEnv({ ...FULL_KV, min_chunk_chars: "0" });

		const config = await resolveConfig(env);

		expect(config.minChunkChars).toBe(0);
		expect(config.source.minChunkChars).toBe("kv");
	});

	it("falls back rather than reading a blanked min_chunk_chars as zero", async () => {
		// `z.coerce.number()` turns "" into 0, and 0 is legal here — so without the
		// blank guard an accidentally-cleared dashboard field would be ACCEPTED,
		// silently disabling the thin-result check while the log line showed a
		// perfectly ordinary 0.
		const { env } = fakeEnv({ ...FULL_KV, min_chunk_chars: "" });

		const config = await resolveConfig(env);

		expect(config.minChunkChars).toBe(200);
		expect(config.source.minChunkChars).toBe("var");
		expect(warn).toHaveBeenCalled();
	});

	it("falls back rather than reading a blanked search_match_threshold as zero", async () => {
		// Same trap, worse consequence: a 0 floor accepts every chunk AI Search
		// can find, which looks like retrieval working unusually well.
		const { env } = fakeEnv({ ...FULL_KV, search_match_threshold: "" });

		const config = await resolveConfig(env);

		expect(config.searchMatchThreshold).toBe(0.5);
		expect(config.source.searchMatchThreshold).toBe("var");
	});

	it("accepts a fractional search_match_threshold and rejects one out of range", async () => {
		expect((await resolveConfig(fakeEnv({ ...FULL_KV, search_match_threshold: "0" }).env)).searchMatchThreshold).toBe(0);
		expect((await resolveConfig(fakeEnv({ ...FULL_KV, search_match_threshold: "1" }).env)).searchMatchThreshold).toBe(1);
		expect((await resolveConfig(fakeEnv({ ...FULL_KV, search_match_threshold: "1.5" }).env)).searchMatchThreshold).toBe(0.5);
		expect((await resolveConfig(fakeEnv({ ...FULL_KV, search_match_threshold: "-0.1" }).env)).searchMatchThreshold).toBe(0.5);
	});

	it("caps max_tool_iterations, so a dashboard edit cannot authorise an unbounded loop", async () => {
		// Every iteration is a billed model call (AGENTS.md §7).
		const { env } = fakeEnv({ ...FULL_KV, max_tool_iterations: "50" });

		const config = await resolveConfig(env);

		expect(config.maxToolIterations).toBe(3);
		expect(config.source.maxToolIterations).toBe("var");
	});

	it("rejects a zero max_tool_iterations, which would make the stage a no-op", async () => {
		const { env } = fakeEnv({ ...FULL_KV, max_tool_iterations: "0" });

		expect((await resolveConfig(env)).maxToolIterations).toBe(3);
	});

	it("caps max_search_results", async () => {
		const { env } = fakeEnv({ ...FULL_KV, max_search_results: "100" });

		expect((await resolveConfig(env)).maxSearchResults).toBe(5);
	});
});
