import { describe, expect, it, vi } from "vitest";
import { colorizeMotif } from "./colorizer";
import { fakeEnv } from "./test-env";
import { resolveConfig } from "../config";
import { sampleParamsFull } from "../fixtures/sample-params";
import { buildColorPrompt } from "../prompts";

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

		expect(form.get("prompt")).toBe(buildColorPrompt(sampleParamsFull));
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
