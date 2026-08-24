import {
  buildAiRunOptions,
  DEFAULT_IMAGE_CACHE_TTL,
  type GatewayConfig,
} from "./aiGateway";
import type { ImageAiRunner } from "./getImageModelOutput";

/**
 * An image handed to the model as a reference.
 *
 * `width` and `height` are optional, and when supplied they are checked before
 * the call bills. The caller is trusted to report them honestly: this package
 * has no image library and does not decode JPEG headers to find out. A caller
 * that does not know its dimensions omits them and the call proceeds.
 */
export interface InputImage {
  /**
   * Narrower than a bare `Uint8Array` on purpose. A `Blob` part must be backed
   * by an `ArrayBuffer`, and bare `Uint8Array` also admits a `SharedArrayBuffer`
   * that cannot be one. Every ordinary source — `new Uint8Array(bytes)`, an R2
   * object's `arrayBuffer()`, a `fetch` response — already produces this.
   */
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  width?: number;
  height?: number;
}

/** Non-model options for an image-to-image call. */
export interface GetImageToImageOutputOptions {
  /**
   * Route the call through AI Gateway. Left unset, `buildAiRunOptions` returns
   * `undefined` and the call goes straight to Workers AI.
   *
   * Iris deliberately does not set this today. The gateway currently fails to
   * carry a multipart body through to the model — every attempt returned
   * `8001: Invalid input`, and the gateway's own log showed the body as an
   * empty object. It also rejects the `ReadableStream` this helper sends
   * outright. The wiring is here in full so that the day it works, a caller
   * turns it on by passing an id and nothing in this file changes.
   */
  gateway?: GatewayConfig;
  /**
   * Model-specific extras merged into the form. Strings, because the multipart
   * form carries `width` and `height` as strings even though the model's JSON
   * schema types them as integers (iris-06 finding). Kept open because `steps`
   * is fixed at 4 on flux-2-klein but may not be on whatever replaces it.
   */
  extras?: Record<string, string>;
}

/** Result of a successful image-to-image call. */
export interface ImageToImageOutput {
  /** Raw decoded image bytes. */
  image: Uint8Array;
  /** MIME type of the returned image. */
  contentType: string;
}

/**
 * Largest input dimension the model is documented to accept.
 *
 * Advisory, not a hard model failure. iris-06 sent a 640x640 input and it was
 * silently accepted, producing a valid output — so this helper rejects only
 * what a caller has told it is oversized, and never guesses. Callers that
 * resize (iris-09's `resolveInputSize`) clamp to this.
 */
export const MAX_INPUT_IMAGE_DIMENSION = 512;

/** Up to four reference images, named input_image_0 through input_image_3. */
export const MAX_INPUT_IMAGES = 4;

/**
 * Calls an image model with a prompt **and** one or more reference images, and
 * returns the decoded bytes of the image it produces.
 *
 * Unlike `getImageModelOutput`, this sends multipart form data rather than a
 * JSON body, because that is what the flux-2-klein family accepts — a JSON
 * body is rejected with `5006: required properties at '/' are 'multipart'`.
 *
 * This call never retries (ADR-0009). It is expensive and one-shot, and a
 * failure is very likely to fail the same way again. It also does not read the
 * gateway cost: `aiGatewayLogId` holds only the most recent routed call on the
 * binding, so a caller making two calls would find the second read returning
 * the first call's cost. The caller reads it, immediately, itself.
 */
export async function getImageToImageOutput(
  prompt: string,
  images: InputImage[],
  model: string,
  ai: ImageAiRunner,
  options: GetImageToImageOutputOptions = {}
): Promise<ImageToImageOutput> {
  // Everything below this point up to `ai.run` is a guard, and every one of
  // them runs before the call. `ai.run` bills; a request that was always going
  // to be rejected must not be able to spend money.
  if (images.length > MAX_INPUT_IMAGES) {
    throw new Error(
      `getImageToImageOutput: model "${model}" accepts at most ` +
        `${MAX_INPUT_IMAGES} input images, but ${images.length} were given.`
    );
  }

  images.forEach((image, index) => {
    const { width, height } = image;
    const oversized =
      (width !== undefined && width >= MAX_INPUT_IMAGE_DIMENSION) ||
      (height !== undefined && height >= MAX_INPUT_IMAGE_DIMENSION);

    if (oversized) {
      throw new Error(
        `getImageToImageOutput: input image ${index} is ${width ?? "?"}x` +
          `${height ?? "?"}, at or above the ${MAX_INPUT_IMAGE_DIMENSION}px ` +
          `limit for model "${model}". Resize it before calling.`
      );
    }
  });

  const form = new FormData();
  form.append("prompt", prompt);

  images.forEach((image, index) => {
    form.append(
      `input_image_${index}`,
      new Blob([image.bytes], { type: image.contentType }),
      `input_${index}`
    );
  });

  for (const [key, value] of Object.entries(options.extras ?? {})) {
    form.append(key, value);
  }

  // A FormData cannot be handed to `ai.run` directly — doing so fails with
  // 3043, and that was the root cause of every early probe failure in iris-06.
  // Serializing through a Response is what generates the multipart boundary
  // and the matching content-type header.
  const formResponse = new Response(form);
  const body = formResponse.body;
  const contentType = formResponse.headers.get("content-type");

  if (!body || !contentType) {
    throw new Error(
      `getImageToImageOutput: failed to serialize the multipart form for ` +
        `model "${model}".`
    );
  }

  const runOptions = buildAiRunOptions(options.gateway, {
    cacheTtl: DEFAULT_IMAGE_CACHE_TTL,
  });

  let response: { image?: string };
  try {
    // `ImageAiRunner.run` is typed `Promise<unknown>` because the binding
    // serves every model shape; iris-06 confirmed firsthand that this family
    // returns `{ image: "<base64>" }`. The narrowing is checked on the next
    // line rather than trusted. Same boundary as getImageModelOutput.ts:55.
    response = (await ai.run(
      model,
      { multipart: { body, contentType } },
      runOptions
    )) as { image?: string };
  } catch (cause) {
    // Distinct from "the model returned nothing usable" below: this one never
    // got a response at all. The caller records the message on an audit row
    // where it is the only clue anyone will have later.
    throw new Error(
      `getImageToImageOutput: the call to model "${model}" failed: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  }

  if (!response || typeof response.image !== "string") {
    throw new Error(
      `getImageToImageOutput: model "${model}" did not return an image.`
    );
  }

  // Same decode as getImageModelOutput.ts:65-66. Not Buffer: it needs
  // nodejs_compat and not every consumer of this package has it.
  const binaryString = atob(response.image);
  const image = Uint8Array.from(binaryString, (c) => c.charCodeAt(0));

  return { image, contentType: "image/jpeg" };
}
