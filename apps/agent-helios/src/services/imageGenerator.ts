import type { Classification, HeliosParams, ReferenceImage } from "@aureline/shared-types";
import {
	getImageModelOutput,
	getImageToImageOutput,
	readJpegDimensions,
	MAX_INPUT_IMAGE_DIMENSION,
} from "@aureline/shared-utils";
import { buildImagePrompt } from "../prompts";
import { imageModelFor, transportFor, type HeliosConfig, type ImageModelConfig } from "../config";
import { readGatewayCost } from "./gatewayCost";
import { describeError } from "../utils";

/**
 * What the image maker returns: the raw decoded bytes and their content type,
 * plus the run's cost read from the AI Gateway log. There is no URL here — the
 * URL only exists once the pipeline has saved the bytes and built it from the
 * returned key (ticket 06, decision 6).
 */
export interface GeneratedImage {
	image: Uint8Array;
	contentType: string;
	cost_usd: number | null;
	/**
	 * What was actually called, for the image row.
	 *
	 * Returned rather than recomputed by the caller: the model now depends on
	 * whether the request carried a reference image, and a row built from
	 * `config.imageModel` alone would name flux-1-schnell for a run that called
	 * klein. That is the lying audit row ADR-0001 exists to prevent, and the only
	 * place the truth is known for certain is here.
	 */
	call: ImageCallRecord;
}

/** What the image call actually sent, as the audit row should record it. */
export interface ImageCallRecord {
	model: string;
	transport: "json" | "multipart";
	/** Only on the JSON path. Omitted where no `steps` was sent. */
	steps?: number;
	referenceImageSent: boolean;
	/** The reference image's own size, or null when it could not be read. */
	referenceDimensions: { width: number; height: number } | null;
}

/** Flux Schnell's prompt field is capped at 2048 characters. */
const MAX_PROMPT_LENGTH = 2048;

/** Flux Schnell's `steps` input is capped at 8 (ticket 06, decision 1). */
const MAX_STEPS = 8;

/** Flux Schnell's own default when `steps` is absent. */
const DEFAULT_STEPS = 4;

/**
 * The `steps` value actually sent to the model. The config schema allows up to
 * 50 because it is model-agnostic; Flux Schnell caps at 8. Exported so the
 * pipeline records what was sent rather than what was configured — a run row
 * claiming 50 steps when the call used 8 is exactly the lying audit row
 * ADR-0001 exists to prevent.
 */
export function resolveSteps(config: HeliosConfig): number {
	return Math.min(config.imageModel.steps ?? DEFAULT_STEPS, MAX_STEPS);
}

/**
 * Image generation stage: renders a black-and-white pattern from the planner's
 * parameters via Flux Schnell (ADR-0004), strictly following them (no
 * unrequested creative drift).
 *
 * `env` carries the `AI` binding and the gateway id; `pipeline_id` reaches the
 * gateway's `metadata` so the log row can be joined back to `helios_runs`. The
 * model and its parameters come from `config.imageModel`, which is resolved
 * from KV once per invocation — never from `env.IMAGE_MODEL` (ADR-0008).
 *
 * This function only calls the model and returns the raw bytes. It does not
 * touch R2 and does not build a URL (ticket 06, decisions 6 and 7); those are
 * the pipeline's job.
 */
export async function generateImage(
	params: HeliosParams,
	config: HeliosConfig,
	env: Env,
	pipeline_id: string,
	/**
	 * The user's reference image, when they attached one.
	 *
	 * Absent, everything below takes the path it always took — same model, same
	 * JSON body, same gateway, same recorded cost. That is the regression
	 * promise, and it is why this is an optional trailing parameter rather than
	 * the function being restructured around it.
	 */
	referenceImage?: ReferenceImage,
	/**
	 * What the classifier decided this design is.
	 *
	 * Optional and trailing for the same reason `referenceImage` is: absent means
	 * tile, which is what every run before Phase 2 was, so a call without it
	 * builds byte-for-byte the prompt it always built. `/resume` omits it.
	 */
	classification?: Classification,
): Promise<GeneratedImage> {
	const prompt = buildFluxPrompt(params, referenceImage !== undefined, classification);
	// Throws when a reference arrived and no image-to-image model is configured,
	// before anything bills.
	const model = imageModelFor(config, referenceImage !== undefined);

	return transportFor(model) === "multipart"
		? generateViaMultipart(prompt, model, env, pipeline_id, referenceImage)
		: generateViaJson(prompt, model, config, env, pipeline_id);
}

/**
 * The text-to-image path: JSON body, through the AI Gateway, cost recorded.
 *
 * Byte-for-byte the call this file has always made. Nothing here knows a
 * reference image exists, which is the point — a request without one cannot be
 * affected by any of the work above.
 */
async function generateViaJson(
	prompt: string,
	model: ImageModelConfig,
	config: HeliosConfig,
	env: Env,
	pipeline_id: string
): Promise<GeneratedImage> {
	const steps = resolveSteps(config);

	// Nothing records this — the playground's own "not captured" list says so.
	// It is the exact text the money is spent on, and the only place the two
	// prompt layers (our template, then the planner's `image_prompt`) can be seen
	// joined together. The length is worth watching: the cap it is checked
	// against is 2048, and `image_prompt` is the part that can grow.
	console.log(`image: model=${model.model} transport=json steps=${steps} chars=${prompt.length} prompt="${prompt}"`);

	const { image, contentType } = await getImageModelOutput(
		prompt,
		model.model,
		env.AI,
		{
			steps,
			...(model.width !== undefined && { width: model.width }),
			...(model.height !== undefined && { height: model.height }),
		},
		{
			gateway: {
				id: env.AI_GATEWAY_ID,
				metadata: { pipeline_id },
				// The gateway caches image replies for an hour, and we have no seed to
				// vary the cache key — without this flag the same concept keeps
				// returning the exact same cached image (ticket 06, decision 4).
				skipCache: true,
			},
		}
	);

	return {
		image,
		contentType,
		cost_usd: await readGatewayCost(env, "image"),
		call: {
			model: model.model,
			transport: "json",
			// What the call actually sent, not what KV holds — the two differ
			// whenever config carries a steps value above Flux's cap.
			steps,
			referenceImageSent: false,
			referenceDimensions: null,
		},
	};
}

/**
 * The image-to-image path: multipart form, no gateway, cost unknowable.
 *
 * Reached only when the request carried a reference image. flux-1-schnell has
 * no image input at all, so this is a different model as well as a different
 * transport — which is why `imageModelFor` picks it rather than a flag being
 * passed down.
 */
async function generateViaMultipart(
	prompt: string,
	model: ImageModelConfig,
	env: Env,
	pipeline_id: string,
	referenceImage?: ReferenceImage
): Promise<GeneratedImage> {
	// An empty array is not a mistake: it is the shape a KV edit produces when
	// `image_model` itself is moved onto a multipart model, and whether the klein
	// family accepts zero input images is an open question this makes reachable
	// without a code change. Until it is answered, only the branch below runs.
	const images = referenceImage === undefined ? [] : [referenceImage];
	const referenceDimensions = measureReference(referenceImage, model.model);

	console.log(
		`image: model=${model.model} transport=multipart images=${images.length} chars=${prompt.length} prompt="${prompt}"`
	);

	const { image, contentType } = await getImageToImageOutput(
		prompt,
		// `width` and `height` are deliberately omitted, which is the helper's
		// documented way to skip its pre-billing size guard. `measureReference`
		// above has already logged the real size, so an oversized upload is loud
		// rather than silently downscaled by the model — but it is still sent,
		// because there is no resize step in a Worker (no `sharp`, no Images
		// binding) and refusing every phone photo would be the wrong trade.
		images.map((reference) => ({ bytes: reference.bytes, contentType: reference.contentType })),
		model.model,
		env.AI,
		{
			// No `extras`. Iris's confirmed klein call sends the prompt and the
			// images and nothing else; `width`/`height` are what produced
			// `5006: Additional or unevaluated properties '/width, /height'`.
			gateway: {
				// No `id`, so `buildAiRunOptions` returns `undefined` and this call
				// goes straight to Workers AI. Not an oversight: multipart through
				// the gateway has never once succeeded — every attempt returned
				// `8001: Invalid input`, its own log showed the body as an empty
				// object, and it rejects the ReadableStream this helper sends
				// (docs/ai-gateway-multipart-findings.md).
				//
				// Both fields are therefore inert today and correct the day an id is
				// passed. `skipCache` matters then: the cache key covers the model
				// inputs, so without it a resume returns the first attempt's image
				// and looks like the model ignored you.
				skipCache: true,
				metadata: { pipeline_id },
			},
		}
	);

	return {
		image,
		contentType,
		cost_usd: ungatedCallCost(model.model),
		call: {
			model: model.model,
			// No `steps`: none was sent, and a row claiming one would be describing
			// a parameter the model never saw.
			transport: "multipart",
			referenceImageSent: referenceImage !== undefined,
			referenceDimensions,
		},
	};
}

/**
 * What an ungated call cost: nothing we can know, so `null`.
 *
 * Deliberately not `readGatewayCost`. That function reads
 * `env.AI.aiGatewayLogId`, which holds **the most recent gateway-routed call on
 * the binding** — and an ungated call does not clear it. The planner ran moments
 * earlier and *did* route through the gateway, so at this point that property
 * still holds the planner's log id. Calling `readGatewayCost` here would not
 * return null; it would return the *planner's* cost and record it on the image
 * row as the image's. A wrong number is worse than a null, because a null is
 * visibly missing.
 */
function ungatedCallCost(model: string): null {
	console.warn(`cost: image call to "${model}" bypassed the gateway, so its cost is unknowable`);
	return null;
}

/**
 * The reference image's dimensions, logged, or null when they cannot be read.
 *
 * Measured and reported rather than enforced. The model downscales an oversized
 * input silently, and silence is the problem: a designer whose 3024x4032 photo
 * came back barely reflected in the output has no way to learn that from the
 * run. So the size goes in the log and on the row.
 *
 * Degrades to null rather than throwing, and the asymmetry from the *output*
 * read is deliberate: `readJpegDimensions` is JPEG-only and a browser file
 * picker will happily hand over a PNG. These numbers answer a debugging
 * question, and failing a run that produced a good image because the question
 * could not be answered would be the wrong trade.
 */
function measureReference(
	referenceImage: ReferenceImage | undefined,
	model: string
): { width: number; height: number } | null {
	if (referenceImage === undefined) return null;

	let size: { width: number; height: number };
	try {
		size = readJpegDimensions(referenceImage.bytes);
	} catch (cause) {
		console.warn(
			`image: could not read the reference image's dimensions (${referenceImage.contentType}):`,
			describeError(cause)
		);
		return null;
	}

	const oversized = size.width >= MAX_INPUT_IMAGE_DIMENSION || size.height >= MAX_INPUT_IMAGE_DIMENSION;
	if (oversized) {
		console.warn(
			`image: reference is ${size.width}x${size.height}, at or above the ` +
				`${MAX_INPUT_IMAGE_DIMENSION}px advisory for "${model}" — sending it anyway, ` +
				`the model will downscale internally`
		);
	} else {
		console.log(`image: reference is ${size.width}x${size.height}`);
	}

	return size;
}

/**
 * Flux Schnell has no negative-prompt field (ticket 06, decision 3), so the
 * translator is asked to fold the exclusions into the main prompt as an explicit
 * "Do not include:" clause. Appending the raw exclusion list instead would read
 * as things to draw, which is the opposite of what it means.
 *
 * Fails fast if the result overruns the model's hard 2048-character cap — before
 * any billed call, so we never pay for a prompt the model will reject anyway.
 */
function buildFluxPrompt(
	params: HeliosParams,
	hasReferenceImage: boolean,
	classification: Classification | undefined,
): string {
	const { prompt } = buildImagePrompt(params, {
		supportsNegativePrompt: false,
		hasReferenceImage,
		...(classification !== undefined && { classification }),
	});
	if (prompt.length > MAX_PROMPT_LENGTH) {
		throw new Error(
			`image prompt is ${prompt.length} characters, exceeding Flux Schnell's ${MAX_PROMPT_LENGTH} cap`
		);
	}
	return prompt;
}

