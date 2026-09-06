import { describe, expect, it, vi } from "vitest";
import { colorizeMotif } from "./colorizer";
import { fakeEnv } from "./test-env";
import { resolveConfig } from "../config";
import { sampleParamsFull } from "../fixtures/sample-params";
import { buildColorPrompt, buildImageModelPrompt } from "../prompts";

const MOTIF_KEY = "patterns/motif.jpg";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-9b";

/**
 * Reads the multipart body back off a captured `ai.run` call.
 *
 * Asserting the arguments structurally would only prove a `body` exists. What
 * matters is what is inside it — the field names the model reads — and the only
 * way to know those are right is to parse the thing that was actually sent.
 */
async function sentForm(run: ReturnType<typeof vi.fn>): Promise<FormData> {
	const [, input] = run.mock.calls[0] ?? [];
	const { body, contentType } = (input as { multipart: { body: BodyInit; contentType: string } }).multipart;

	return new Response(body, { headers: { "content-type": contentType } }).formData();
}

describe("colorizeMotif", () => {
	it("returns the coloured bytes with dimensions read from them", async () => {
		const { env } = fakeEnv();
		const config = await resolveConfig(env);

		const result = await colorizeMotif(MOTIF_KEY, sampleParamsFull, config, env, "run-a");

		expect(result.image).toBeInstanceOf(Uint8Array);
		expect(result.contentType).toBe("image/jpeg");
		// The fixture is a real 128x128 JPEG, so these prove the dimensions were
		// parsed out of the returned bytes rather than copied from a constant or
		// from the input.
		expect(result).toMatchObject({ width: 128, height: 128 });
		expect(result.inputDimensions).toEqual({ width: 128, height: 128 });
		// Decoded, not passed through: the model replies with base64.
		expect([...result.image.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
	});

	it("reports a null cost, because this call does not route through the gateway", async () => {
		const { env } = fakeEnv();
		const config = await resolveConfig(env);

		const result = await colorizeMotif(MOTIF_KEY, sampleParamsFull, config, env, "run-a");

		// Decision 10, not a bug. If this ever starts returning a number, the
		// gateway began carrying multipart and several review gates reopen.
		expect(result.cost_usd).toBeNull();
	});

	it("does not bill this run for the planner's cost when a stale log id is on the binding", async () => {
		// The state production is actually in at this point. The planner ran
		// moments ago and *did* route through the gateway, so `aiGatewayLogId`
		// holds its log id — an ungated call does not clear it. Reading the
		// gateway here returns 0.0042, the planner's cost, and records it on the
		// image row as the image's. A wrong number is worse than a null, because
		// a null is visibly missing.
		const getLog = vi.fn().mockResolvedValue({ cost: 0.0042 });
		const { env } = fakeEnv({ aiGatewayLogId: "planner-log-id", getLog });
		const config = await resolveConfig(env);

		const result = await colorizeMotif(MOTIF_KEY, sampleParamsFull, config, env, "run-a");

		expect(result.cost_usd).toBeNull();
		// The stronger half: not merely that the number was discarded, but that
		// the gateway was never asked. Asking at all is the bug.
		expect(getLog).not.toHaveBeenCalled();
	});

	it("calls the configured model with a multipart body and no gateway options", async () => {
		const { env, run } = fakeEnv();
		const config = await resolveConfig(env);

		await colorizeMotif(MOTIF_KEY, sampleParamsFull, config, env, "run-a");

		const [model, input, options] = run.mock.calls[0] ?? [];
		expect(model).toBe(IMAGE_MODEL);
		expect(input).toHaveProperty("multipart.body");
		expect(input).toHaveProperty("multipart.contentType");
		// The assertion that pins decision 10. `buildAiRunOptions` returns
		// undefined when no gateway id is passed, so an `undefined` here is the
		// call going straight to Workers AI. Anything else means someone turned
		// the gateway on, and this test is where they find out.
		expect(options).toBeUndefined();
	});

	it("sends the colour prompt and the motif under the field names the model reads", async () => {
		const { env, run } = fakeEnv();
		const config = await resolveConfig(env);

		await colorizeMotif(MOTIF_KEY, sampleParamsFull, config, env, "run-a");
		const form = await sentForm(run);

		// The composed string, both layers. Asserting on `buildColorPrompt` alone
		// would pass just as well if the colorizer silently dropped the planner's
		// `image_prompt` — which is the failure worth catching here.
		expect(form.get("prompt")).toBe(buildImageModelPrompt(sampleParamsFull));
		expect(form.get("prompt")).toContain(buildColorPrompt(sampleParamsFull));
		expect(form.get("prompt")).toContain(sampleParamsFull.image_prompt);
		// `input_image_0`, not `image`. Sending the wrong name was a real bug in
		// iris-06's probe and it does not fail loudly: the model falls back to
		// text-to-image and returns something unrelated that looks like a result.
		expect(form.get("input_image_0")).toBeInstanceOf(Blob);
		// No width or height, matching iris-06's confirmed image-to-image call.
		expect(form.get("width")).toBeNull();
		expect(form.get("height")).toBeNull();
	});

	it("throws without calling the model when the motif cannot be read", async () => {
		const { env, run, patternsGet } = fakeEnv();
		const config = await resolveConfig(env);
		patternsGet.mockResolvedValueOnce(null);

		await expect(colorizeMotif("patterns/gone.jpg", sampleParamsFull, config, env, "run-a")).rejects.toThrow(
			/patterns\/gone\.jpg/,
		);

		// The assertion that protects the budget. An error thrown *after* the call
		// still bills, so a guard that runs in the wrong order is invisible unless
		// something checks this.
		expect(run).not.toHaveBeenCalled();
	});

	it("propagates the helper's error when the model returns no image", async () => {
		const { env, run } = fakeEnv();
		const config = await resolveConfig(env);
		run.mockResolvedValueOnce({ notAnImage: true });

		await expect(colorizeMotif(MOTIF_KEY, sampleParamsFull, config, env, "run-a")).rejects.toThrow(
			/did not return an image/,
		);
	});

	it("still completes when the motif's own dimensions cannot be read", async () => {
		const { env, patternsGet } = fakeEnv();
		const config = await resolveConfig(env);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		// A PNG signature. `readJpegDimensions` is JPEG-only, and `motif_ref` can
		// point at whatever content type a bucket or a server declares.
		patternsGet.mockResolvedValueOnce({
			arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
			httpMetadata: { contentType: "image/png" },
		});

		try {
			const result = await colorizeMotif(MOTIF_KEY, sampleParamsFull, config, env, "run-a");

			// The run produced a good image. Failing it because a debugging field
			// could not be filled would be the wrong trade.
			expect(result.width).toBe(128);
			expect(result.inputDimensions).toBeNull();
			// Null, but never silent.
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
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

describe("colorizeMotif with a reference image", () => {
	it("sends the motif first and the reference second", async () => {
		const { env, run } = fakeEnv();
		const config = await resolveConfig(env);

		await colorizeMotif(MOTIF_KEY, sampleParamsFull, config, env, "run-a", referenceOfSize(400, 300));

		const form = await sentForm(run);
		// Position is the contract: the prompt names them in this order, so a swap
		// leaves both the array and the prompt valid while the model recolours the
		// photograph and reads the pattern as a palette.
		const reference = new Uint8Array(await (form.get("input_image_1") as File).arrayBuffer());
		expect(form.get("input_image_0")).toBeInstanceOf(Blob);
		expect(Array.from(reference)).toEqual(Array.from(jpegOfSize(400, 300)));
	});

	it("records that the reference reached the model, and its size", async () => {
		const { env } = fakeEnv();
		const config = await resolveConfig(env);

		const result = await colorizeMotif(
			MOTIF_KEY,
			sampleParamsFull,
			config,
			env,
			"run-a",
			referenceOfSize(400, 300),
		);

		expect(result.referenceImageSent).toBe(true);
		expect(result.referenceDimensions).toEqual({ width: 400, height: 300 });
	});

	it("records that none was sent when none was attached", async () => {
		const { env } = fakeEnv();
		const config = await resolveConfig(env);

		const result = await colorizeMotif(MOTIF_KEY, sampleParamsFull, config, env, "run-a");

		expect(result.referenceImageSent).toBe(false);
		expect(result.referenceDimensions).toBeNull();
	});

	it("warns about an oversized reference and sends it anyway", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { env, run } = fakeEnv();
		const config = await resolveConfig(env);

		try {
			// A phone photo, far over the 512px advisory. The model downscales it
			// internally and says nothing, which is exactly why this logs.
			const result = await colorizeMotif(
				MOTIF_KEY,
				sampleParamsFull,
				config,
				env,
				"run-a",
				referenceOfSize(3024, 4032),
			);

			expect(warn).toHaveBeenCalledWith(expect.stringContaining("3024x4032"));
			expect(run).toHaveBeenCalledTimes(1);
			expect(result.referenceDimensions).toEqual({ width: 3024, height: 4032 });
		} finally {
			warn.mockRestore();
		}
	});

	it("still runs when the reference is not a readable JPEG, recording a null size", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { env, run } = fakeEnv();
		const config = await resolveConfig(env);
		// A PNG signature. A browser file picker will hand one over, and the size
		// only answers a debugging question — it must not fail a good run.
		const png = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), contentType: "image/png" };

		try {
			const result = await colorizeMotif(MOTIF_KEY, sampleParamsFull, config, env, "run-a", png);

			expect(run).toHaveBeenCalledTimes(1);
			expect(result.referenceImageSent).toBe(true);
			expect(result.referenceDimensions).toBeNull();
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});
