import type { IrisParams } from "@aureline/shared-types";
import { getImageToImageOutput } from "@aureline/shared-utils";
import type { IrisConfig } from "../config";
import { buildColorPrompt } from "../prompts";
import { readMotif } from "../repository/r2.repository";
import { readGatewayCost } from "./gatewayCost";
import { readJpegDimensions } from "./imageDimensions";
import { describeError } from "../utils";

/** What the image stage hands back. Raw bytes only — it does not know R2 exists. */
export interface ColorizedMotif {
	image: Uint8Array;
	contentType: string;
	/** The coloured image's real dimensions, read from the bytes it returned. */
	width: number;
	height: number;
	/**
	 * The motif's own dimensions, or null when they could not be read.
	 *
	 * Not in iris-09's agreed shape, and added deliberately: `runImageStage` has
	 * to record `original_dimensions` and never sees the motif bytes, so without
	 * this the only way to fill that field is to fetch the motif a second time
	 * purely to measure it.
	 */
	inputDimensions: { width: number; height: number } | null;
	cost_usd: number | null;
}

/**
 * Image colorization stage: colours an existing motif according to the
 * planner's parameters.
 *
 * Returns raw bytes only. Saving to R2 and building a URL are the pipeline's
 * job (iris-09 decision 5), which is what lets this be tested without a bucket.
 *
 * Never retries (ADR-0009). The call is the expensive half of the invocation
 * and a failure is very likely to fail the same way again, so a retry is a
 * person going through `POST /resume`, not a loop here.
 */
export async function colorizeMotif(
	motifRef: string,
	params: IrisParams,
	config: IrisConfig,
	env: Env,
	pipeline_id: string,
): Promise<ColorizedMotif> {
	// Before the model call, so a missing or unreadable motif costs nothing.
	// `readMotif` throws naming the ref on every failure path.
	const motif = await readMotif(env.PATTERNS, motifRef);

	const result = await getImageToImageOutput(
		buildColorPrompt(params),
		[
			{
				bytes: motif.bytes,
				contentType: motif.contentType,
				// `width` and `height` are deliberately omitted, which is iris-07's
				// documented way to skip its size guard.
				//
				// There is no resize step (iris-09 decision 3). iris-06 sent a 640x640
				// input and the model accepted it silently, downscaling internally, so
				// the documented "under 512x512" is best practice rather than a hard
				// failure. Adding one is not cheap: Workers have no `sharp`;
				// `fetch(url, { cf: { image } })` only applies on a proxied Cloudflare
				// zone with Image Resizing enabled, which this Worker does not run on,
				// and under `wrangler dev` it is a low-fidelity mock that would pass
				// every local check while shipping an unresized motif; the Images
				// binding is the correct answer but needs Images enabled on the
				// account, which is a human's action. A WASM decoder is real work for
				// a constraint the model does not actually enforce.
			},
		],
		config.imageModel.model,
		env.AI,
		{
			// No `extras`. iris-06's confirmed image-to-image call sends only the
			// prompt and the input image; the one call that sent explicit width and
			// height was text-to-image, a different path. Whatever size comes back
			// is read off the bytes below, so the audit row stays truthful without
			// this having to assume an untested request shape.
			gateway: {
				// No `id`, so `buildAiRunOptions` returns `undefined` and this call
				// goes straight to Workers AI. Not an oversight, and not a config
				// slip: multipart through the `iris` gateway has never once
				// succeeded — every attempt returned `8001: Invalid input` with the
				// gateway's own log showing the body as an empty object, and it
				// rejects the ReadableStream this helper sends outright. See
				// docs/ai-gateway-multipart-findings.md (untracked, local).
				//
				// Both fields below are therefore inert today and correct the day an
				// id is passed. `skipCache` matters then: the cache key covers the
				// model inputs, so without it a resume returns the first attempt's
				// image and looks like the model ignored you.
				skipCache: true,
				metadata: { pipeline_id },
			},
		},
	);

	// Throws rather than degrading. These two numbers are what `IrisResultSchema`
	// promises Atlas, and `model_metadata` is their only durable home
	// (iris-03 decision 9), so a null here is a wrong answer rather than a
	// missing one.
	const { width, height } = readJpegDimensions(result.image);

	return {
		image: result.image,
		contentType: result.contentType,
		width,
		height,
		inputDimensions: readMotifDimensions(motif.bytes, motifRef),
		// Null today, for the same reason the gateway is off above. `readGatewayCost`
		// tolerates that by design and never fails a run for it (iris-08 decision 5).
		cost_usd: await readGatewayCost(env, "image"),
	};
}

/**
 * The motif's dimensions, or null.
 *
 * Degrades where the output read throws, and the asymmetry is deliberate.
 * `motif_ref` can point at whatever content type R2 or a remote server
 * declares, and `readJpegDimensions` is JPEG-only, so this read can fail for
 * reasons that say nothing about whether the run worked. These numbers only
 * answer a debugging question — "was the input mangled on the way in" — and
 * failing a run that produced a good image because that question cannot be
 * answered would be the wrong trade. It logs, so the null is never silent.
 */
function readMotifDimensions(bytes: Uint8Array, motifRef: string): { width: number; height: number } | null {
	try {
		return readJpegDimensions(bytes);
	} catch (cause) {
		console.warn(`colorizer: could not read dimensions of motif "${motifRef}":`, describeError(cause));
		return null;
	}
}
