import type { IrisParams, ReferenceImage } from "@aureline/shared-types";
import { getImageToImageOutput, readJpegDimensions, MAX_INPUT_IMAGE_DIMENSION } from "@aureline/shared-utils";
import type { IrisConfig } from "../config";
import { buildImageModelPrompt } from "../prompts";
import { readMotif } from "../repository/r2.repository";
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
	/**
	 * Whether the user's reference image went to the model alongside the motif.
	 *
	 * Distinct from the text row's `had_reference_image`, which says the *planner*
	 * saw one. The two disagree on a `/resume`, and that disagreement is the whole
	 * record: the params were shaped by a picture, this attempt's pixels were not.
	 */
	referenceImageSent: boolean;
	/** The reference's own dimensions, or null when they could not be read. */
	referenceDimensions: { width: number; height: number } | null;
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
	/**
	 * The user's reference image, when they attached one.
	 *
	 * Absent, everything below builds the byte-identical single-image call it
	 * always built. `/resume` never has one — the image is transient and was
	 * never persisted — so a resumed run is unchanged by this parameter existing.
	 */
	referenceImage?: ReferenceImage,
): Promise<ColorizedMotif> {
	// Before the model call, so a missing or unreadable motif costs nothing.
	// `readMotif` throws naming the ref on every failure path.
	const motif = await readMotif(env.PATTERNS, motifRef);

	// The composed string, not `buildColorPrompt` alone: the planner's
	// `image_prompt` is appended to it and is part of what the model is asked
	// for. Calling the deterministic half here would silently drop that layer.
	const prompt = buildImageModelPrompt(params, { hasReferenceImage: referenceImage !== undefined });

	const referenceDimensions = measureReference(referenceImage, config.imageModel.model);

	// Nothing records this — the playground's own "not captured" list says so.
	// It is the exact text the money is spent on, and the only place the two
	// prompt layers can be seen joined together. `images` separates "the
	// reference was ignored" from "the reference never arrived".
	console.log(
		`image: model=${config.imageModel.model} motif=${motifRef} images=${referenceImage === undefined ? 1 : 2} prompt="${prompt}"`,
	);

	const result = await getImageToImageOutput(
		prompt,
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
			// **Order is the contract.** The motif is `input_image_0` and the
			// reference is `input_image_1`, and the prompt tells the model which is
			// which in exactly those terms ("the first image... the second image").
			// Swapping them would leave both the prompt and this array valid while
			// the model recoloured the photograph and treated the pattern as a
			// palette — a full-price run that looks like the model ignored us.
			//
			// A spread rather than a conditional array, so a run without a reference
			// builds the same one-element array it always did.
			...(referenceImage === undefined
				? []
				: [
						{
							bytes: referenceImage.bytes,
							contentType: referenceImage.contentType,
							// Omitted for the same reason as the motif's: the guard above
							// rejects before billing, and `measureReference` has already
							// logged the real size loudly.
						},
					]),
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
		cost_usd: ungatedCallCost(config.imageModel.model),
		referenceImageSent: referenceImage !== undefined,
		referenceDimensions,
	};
}

/**
 * The reference image's dimensions, logged, or null when they cannot be read.
 *
 * Measured and reported rather than enforced. The model downscales an oversized
 * input silently, and the silence is the problem: a designer whose 3024x4032
 * photo came back barely reflected in the output has no way to learn that from
 * the run. So the size goes in the log and on the row.
 *
 * Degrades to null rather than throwing, for the same reason
 * `readMotifDimensions` does — and with one more reason here.
 * `readJpegDimensions` is JPEG-only, and a browser file picker will hand over a
 * PNG. These numbers only answer a debugging question; failing a run that
 * produced a good image because the question could not be answered would be the
 * wrong trade.
 */
function measureReference(
	referenceImage: ReferenceImage | undefined,
	model: string,
): { width: number; height: number } | null {
	if (referenceImage === undefined) return null;

	let size: { width: number; height: number };
	try {
		size = readJpegDimensions(referenceImage.bytes);
	} catch (cause) {
		console.warn(
			`colorizer: could not read the reference image's dimensions (${referenceImage.contentType}):`,
			describeError(cause),
		);
		return null;
	}

	if (size.width >= MAX_INPUT_IMAGE_DIMENSION || size.height >= MAX_INPUT_IMAGE_DIMENSION) {
		console.warn(
			`colorizer: reference is ${size.width}x${size.height}, at or above the ` +
				`${MAX_INPUT_IMAGE_DIMENSION}px advisory for "${model}" — sending it anyway, ` +
				`the model will downscale internally`,
		);
	} else {
		console.log(`colorizer: reference is ${size.width}x${size.height}`);
	}

	return size;
}

/**
 * What an ungated call cost: nothing we can know, so `null`.
 *
 * Deliberately not `readGatewayCost`. That function reads
 * `env.AI.aiGatewayLogId`, which holds **the most recent gateway-routed call on
 * the binding** — and an ungated call does not clear it. The planner ran
 * moments earlier and *did* route through the gateway, so at this point that
 * property still holds the planner's log id. Calling `readGatewayCost` here
 * therefore does not return null; it returns the *planner's* cost, and records
 * it on the image row as the image's cost. A number is worse than a null,
 * because a null is visibly missing and a wrong number is not.
 *
 * The day multipart routes through the gateway, this becomes a real
 * `readGatewayCost` call again — same place, same line.
 */
function ungatedCallCost(model: string): null {
	console.warn(`cost: image call to "${model}" bypassed the gateway, so its cost is unknowable`);
	return null;
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
