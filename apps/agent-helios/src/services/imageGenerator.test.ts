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
	image_prompt: "Keep each paisley's internal ornament legible at a small scale.",
};

const CONFIG: HeliosConfig = {
	textModel: { model: "@cf/openai/gpt-oss-120b" },
	// Empty, which is the "no vision model configured" state `plannerModelFor`
	// falls back from. The image stage does not read it either way.
	visionTextModel: { model: "" },
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
	maxRetries: 2,
	retentionLimit: 5,
	maxResumeAttempts: 3,
	source: {
		textModel: "var",
		visionTextModel: "var",
		imageModel: "kv",
		imageToImageModel: "var",
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
			metadata: { pipeline_id: "p-123" },
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

	it("records what it sent: the JSON model, its transport, and no reference", async () => {
		const { env } = fakeEnv();

		const result = await generateImage(PARAMS, CONFIG, env, "p-123");

		// The audit row is built from this. A model name here that is not the one
		// `run` was called with is the lying row ADR-0001 exists to prevent.
		expect(result.call).toEqual({
			model: "@cf/black-forest-labs/flux-1-schnell",
			transport: "json",
			steps: 4,
			referenceImageSent: false,
			referenceDimensions: null,
		});
	});
});

/**
 * A minimal but structurally real JPEG: SOI then an SOF0 declaring the size.
 *
 * Real enough for `readJpegDimensions`, which is what decides whether the
 * oversize warning fires and what lands in `referenceDimensions`.
 */
function jpegOfSize(width: number, height: number): Uint8Array<ArrayBuffer> {
	return new Uint8Array([
		0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
		(height >> 8) & 0xff, height & 0xff,
		(width >> 8) & 0xff, width & 0xff,
		0x03,
	]);
}

function referenceOfSize(width: number, height: number) {
	return { bytes: jpegOfSize(width, height), contentType: "image/jpeg" };
}

describe("generateImage with a reference image", () => {
	it("calls the image-to-image model over multipart instead of the text-to-image one", async () => {
		const { env, run } = fakeEnv();

		await generateImage(PARAMS, CONFIG, env, "p-123", referenceOfSize(400, 400));

		const [model, rawInput] = run.mock.calls[0];
		// Not flux-1-schnell. That model has no image input at all, so sending a
		// reference to it would silently produce a result that ignored the upload.
		expect(model).toBe("@cf/black-forest-labs/flux-2-klein-9b");
		expect(rawInput).toHaveProperty("multipart.body");
		expect(rawInput).toHaveProperty("multipart.contentType");
	});

	it("puts the reference in the field name the model reads", async () => {
		const { env, run } = fakeEnv();

		await generateImage(PARAMS, CONFIG, env, "p-123", referenceOfSize(400, 400));

		// Parsed back off the wire rather than asserted structurally: the field
		// name is the thing that has to be right, and only the body knows it.
		const { multipart } = run.mock.calls[0][1] as { multipart: { body: BodyInit; contentType: string } };
		const form = await new Response(multipart.body, {
			headers: { "content-type": multipart.contentType },
		}).formData();

		expect(form.get("input_image_0")).toBeInstanceOf(Blob);
		expect(form.get("prompt")).toContain("reference image");
	});

	it("does not route through the gateway, and reports a null cost rather than the planner's", async () => {
		// `aiGatewayLogId` still holds the planner's id at this point, and an
		// ungated call does not clear it. Reading the gateway here would bill this
		// run for the planner's cost.
		const { env, run, getLog } = fakeEnv({ aiGatewayLogId: "planner-log-id" });

		const result = await generateImage(PARAMS, CONFIG, env, "p-123", referenceOfSize(400, 400));

		// `buildAiRunOptions` returns undefined when no gateway id is passed.
		// Anything else here means someone turned the gateway on, and multipart
		// through it has never once succeeded.
		expect(run.mock.calls[0][2]).toBeUndefined();
		expect(result.cost_usd).toBeNull();
		expect(getLog).not.toHaveBeenCalled();
	});

	it("records the model, the transport, the reference and its size — and no steps", async () => {
		const { env } = fakeEnv();

		const result = await generateImage(PARAMS, CONFIG, env, "p-123", referenceOfSize(400, 300));

		expect(result.call).toEqual({
			model: "@cf/black-forest-labs/flux-2-klein-9b",
			transport: "multipart",
			referenceImageSent: true,
			referenceDimensions: { width: 400, height: 300 },
		});
		// Explicitly absent, not zero or undefined-but-present: no steps value was
		// sent, and a row carrying one would describe a parameter the model never
		// saw.
		expect(result.call).not.toHaveProperty("steps");
	});

	it("warns about an oversized reference and sends it anyway", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { env, run } = fakeEnv();

		// A phone photo. Far over the 512px advisory, which the model handles by
		// downscaling internally — silently, which is the part worth logging.
		const result = await generateImage(PARAMS, CONFIG, env, "p-123", referenceOfSize(3024, 4032));

		expect(warn).toHaveBeenCalledWith(expect.stringContaining("3024x4032"));
		expect(run).toHaveBeenCalledTimes(1);
		expect(result.call.referenceDimensions).toEqual({ width: 3024, height: 4032 });
		warn.mockRestore();
	});

	it("still runs when the reference is not a readable JPEG, recording a null size", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { env, run } = fakeEnv();
		// A PNG signature. A file picker will hand one over, and
		// `readJpegDimensions` throws on it — but the size only answers a
		// debugging question, so it must not fail an otherwise good run.
		const png = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), contentType: "image/png" };

		const result = await generateImage(PARAMS, CONFIG, env, "p-123", png);

		expect(run).toHaveBeenCalledTimes(1);
		expect(result.call.referenceImageSent).toBe(true);
		expect(result.call.referenceDimensions).toBeNull();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("refuses before billing when no image-to-image model is configured", async () => {
		const { env, run } = fakeEnv();
		const config = { ...CONFIG, imageToImageModel: { model: "", transport: "multipart" as const } };

		await expect(
			generateImage(PARAMS, config, env, "p-123", referenceOfSize(400, 400)),
		).rejects.toThrow(/no image_to_image_model is configured/);

		// The assertion that makes this worth having: nothing was spent.
		expect(run).not.toHaveBeenCalled();
	});
});
