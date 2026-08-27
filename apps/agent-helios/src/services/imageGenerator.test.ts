import { describe, expect, it, vi } from "vitest";
import type { HeliosParams } from "@aureline/shared-types";
import { buildImagePrompt } from "../prompts";
import { generateImage, type GeneratedImage } from "./imageGenerator";
import type { HeliosConfig } from "../config";
import { fakeEnv as sharedEnv } from "./test-env";

const PARAMS: HeliosParams = {
	motif_type: "art deco paisley",
	repeat_type: "half-drop",
	scale: "medium",
	density: "balanced",
	line_weight: "medium",
	texture_technique: "hatching",
	contrast_level: "high",
	style: "traditional",
};

const CONFIG: HeliosConfig = {
	textModel: { model: "@cf/openai/gpt-oss-120b" },
	imageModel: {
		model: "@cf/black-forest-labs/flux-1-schnell",
		width: 1024,
		height: 1024,
		steps: 4,
	},
	maxRetries: 2,
	retentionLimit: 5,
	maxResumeAttempts: 3,
	source: {
		textModel: "var",
		imageModel: "kv",
		maxRetries: "var",
		retentionLimit: "var",
		maxResumeAttempts: "var",
	},
};

/** base64 for the bytes [72, 101, 108, 108, 111] ("Hello") */
const BASE64 = "SGVsbG8=";

/**
 * Builds a fake `Env` whose `AI` binding returns a stubbed image and a stubbed
 * gateway log. No Worker runtime and no model call, so the suite stays free.
 *
 * Delegates to the shared fake so there is one `Env` definition in the app.
 * `generateImage` only ever calls the image model, so `runResult` maps onto the
 * shared fake's image reply.
 */
function fakeEnv(overrides: {
	runResult?: unknown;
	logResult?: { cost?: number } | (Error & { cost?: never });
	aiGatewayLogId?: string | null;
} = {}) {
	const { runResult = { image: BASE64 }, logResult = { cost: 0.0019008 }, aiGatewayLogId = "log-123" } =
		overrides;

	const getLog = vi.fn().mockResolvedValue(logResult);
	const { env, run, gateway } = sharedEnv({ image: runResult, getLog, aiGatewayLogId });

	return { env, run, getLog, gateway };
}

describe("generateImage", () => {
	it("sends the folded prompt, config model, steps, width and height to the model", async () => {
		const { env, run } = fakeEnv();

		await generateImage(PARAMS, CONFIG, env, "p-123");

		// Flux Schnell has no negative field, so the exclusions arrive inside the
		// main prompt behind a "Do not include:" lead-in rather than appended raw,
		// which would read as things to draw.
		const { prompt, negative_prompt } = buildImagePrompt(PARAMS, {
			supportsNegativePrompt: false,
		});
		expect(negative_prompt).toBeNull();
		expect(prompt).toMatch(/Do not include: .+\.$/);

		expect(run).toHaveBeenCalledTimes(1);
		// `Ai.run` is typed with `unknown` arguments, which is its real shape, so
		// what the call carried is narrowed here rather than read off an inferred
		// signature that only happened to match.
		const [, rawInput, rawOptions] = run.mock.calls[0];
		const input = rawInput as { prompt: string; steps: number; width: number; height: number };
		const options = rawOptions as { gateway: unknown };
		expect(input.prompt).toBe(prompt);
		expect(input.steps).toBe(4);
		expect(input.width).toBe(1024);
		expect(input.height).toBe(1024);

		// The gateway options carry the invocation id and bypass the cache.
		expect(options.gateway).toEqual({
			id: "helios",
			metadata: { p_invoc_id: "p-123" },
			cacheTtl: expect.any(Number),
			skipCache: true,
		});
	});

	it("sends skipCache so the same concept is not served from the gateway cache", async () => {
		const { env, run } = fakeEnv();

		await generateImage(PARAMS, CONFIG, env, "p-123");

		const options = run.mock.calls[0][2] as { gateway: { skipCache: boolean } };
		expect(options.gateway.skipCache).toBe(true);
	});

	it("returns the decoded image bytes and their content type", async () => {
		const { env } = fakeEnv();

		const result = await generateImage(PARAMS, CONFIG, env, "p-123");

		expect(result.contentType).toBe("image/jpeg");
		expect(Array.from(result.image)).toEqual([72, 101, 108, 108, 111]);
	});

	it("takes the cost from the gateway log and puts it on the returned object", async () => {
		const { env } = fakeEnv();
		const logId = env.AI.aiGatewayLogId ?? "";

		const result = await generateImage(PARAMS, CONFIG, env, "p-123");

		expect(env.AI.gateway).toHaveBeenCalledWith("helios");
		expect(env.AI.gateway("helios").getLog).toHaveBeenCalledWith(logId);
		expect(result.cost_usd).toBe(0.0019008);
	});

	it("leaves cost null when the gateway log is missing or fails", async () => {
		const noLog = fakeEnv({ aiGatewayLogId: null });
		const noLogResult: GeneratedImage = await generateImage(PARAMS, CONFIG, noLog.env, "p-123");
		expect(noLogResult.cost_usd).toBeNull();

		const failing = fakeEnv();
		failing.getLog.mockRejectedValue(new Error("log not found"));
		const failingResult: GeneratedImage = await generateImage(PARAMS, CONFIG, failing.env, "p-123");
		expect(failingResult.cost_usd).toBeNull();
	});

	it("throws when the model returns no image field", async () => {
		const { env } = fakeEnv({ runResult: {} });

		await expect(generateImage(PARAMS, CONFIG, env, "p-123")).rejects.toThrow(
			/did not return an image/i
		);
	});

	it("clamps steps to Flux Schnell's cap of 8 even if config allows more", async () => {
		const { env, run } = fakeEnv();
		const config = { ...CONFIG, imageModel: { ...CONFIG.imageModel, steps: 50 } };

		await generateImage(PARAMS, config, env, "p-123");

		const input = run.mock.calls[0][1] as { steps: number };
		expect(input.steps).toBe(8);
	});
});
