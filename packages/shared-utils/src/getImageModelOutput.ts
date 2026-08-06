import {
  buildAiRunOptions,
  DEFAULT_IMAGE_CACHE_TTL,
  type AiRunOptions,
  type GatewayConfig,
} from "./aiGateway";

/**
 * Minimal interface for the image-model-calling client this helper needs.
 * In Cloudflare Workers, this is typically `env.AI`.
 */
export interface ImageAiRunner {
  run: (
    model: string,
    input: Record<string, unknown>,
    options?: AiRunOptions
  ) => Promise<unknown>;
}

/** Non-model options for an image generation call. */
export interface GetImageModelOutputOptions {
  /**
   * Route the call through AI Gateway. When an id is set, responses are
   * cached for DEFAULT_IMAGE_CACHE_TTL seconds unless the caller overrides
   * `cacheTtl` or sets `skipCache`. Note that the cache key covers the model
   * inputs, so varying `seed` produces a fresh generation.
   */
  gateway?: GatewayConfig;
}

/** Result of a successful image generation call. */
export interface ImageModelOutput {
  /** Raw decoded image bytes. */
  image: Uint8Array;
  /** MIME type of the returned image. */
  contentType: string;
}

/**
 * Calls an image model with a prompt and returns the decoded image bytes.
 * Cloudflare Workers AI image models (e.g. flux-1-schnell) return a
 * base64-encoded JPEG string in `response.image`; this decodes it to bytes.
 */
export async function getImageModelOutput(
  prompt: string,
  model: string,
  ai: ImageAiRunner,
  input: Record<string, unknown> = {},
  options: GetImageModelOutputOptions = {}
): Promise<ImageModelOutput> {
  const runOptions = buildAiRunOptions(options.gateway, {
    cacheTtl: DEFAULT_IMAGE_CACHE_TTL,
  });

  const response = (await ai.run(model, { prompt, ...input }, runOptions)) as {
    image?: string;
  };

  if (!response || typeof response.image !== "string") {
    throw new Error(
      `getImageModelOutput: model "${model}" did not return an image.`
    );
  }

  const binaryString = atob(response.image);
  const image = Uint8Array.from(binaryString, (c) => c.charCodeAt(0));

  return { image, contentType: "image/jpeg" };
}
