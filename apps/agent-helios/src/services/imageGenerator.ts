import type { HeliosParams } from "@aureline/shared-types";
import { getImageModelOutput } from "@aureline/shared-utils";
import { buildImagePrompt } from "../prompts";
import type { HeliosConfig } from "../config";

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
 * `env` carries the `AI` binding and the gateway id; `p_invoc_id` reaches the
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
	p_invoc_id: string
): Promise<GeneratedImage> {
	const prompt = buildFluxPrompt(params);
	const steps = resolveSteps(config);

	const { image, contentType } = await getImageModelOutput(
		prompt,
		config.imageModel.model,
		env.AI,
		{
			steps,
			...(config.imageModel.width !== undefined && { width: config.imageModel.width }),
			...(config.imageModel.height !== undefined && { height: config.imageModel.height }),
		},
		{
			gateway: {
				id: env.AI_GATEWAY_ID,
				metadata: { p_invoc_id },
				// The gateway caches image replies for an hour, and we have no seed to
				// vary the cache key — without this flag the same concept keeps
				// returning the exact same cached image (ticket 06, decision 4).
				skipCache: true,
			},
		}
	);

	return { image, contentType, cost_usd: await readImageCost(env) };
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
function buildFluxPrompt(params: HeliosParams): string {
	const { prompt } = buildImagePrompt(params, { supportsNegativePrompt: false });
	if (prompt.length > MAX_PROMPT_LENGTH) {
		throw new Error(
			`image prompt is ${prompt.length} characters, exceeding Flux Schnell's ${MAX_PROMPT_LENGTH} cap`
		);
	}
	return prompt;
}

/**
 * Reads the image's cost (real dollars) from the AI Gateway log written by the
 * just-completed call. The image model's own reply carries no usage, so the
 * Gateway log is the only source. A missing, failed or unlogged cost is always
 * tolerated as `null` — a missing cost must never fail a run (ticket 06).
 */
async function readImageCost(env: Env): Promise<number | null> {
	try {
		const logId = env.AI.aiGatewayLogId;
		if (!logId) {
			return null;
		}
		const log = await env.AI.gateway(env.AI_GATEWAY_ID).getLog(logId);
		return log.cost ?? null;
	} catch {
		return null;
	}
}
