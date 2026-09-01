/**
 * Base64 for image bytes.
 *
 * Its own module rather than a helper inside a caller, because the encode
 * direction is now needed by `getTextualModelOutput` (to build the `data:` URL
 * a multimodal message carries) and the decode direction already exists,
 * duplicated, inside `getImageModelOutput` and `getImageToImageOutput`. Those
 * two are deliberately left alone — `atlas-07` forbids modifying
 * `packages/shared-utils` while Atlas is mid-sprint, and a new file is the
 * mildest form that constraint can be bent in. Fold them in here when that
 * sprint ends.
 *
 * `btoa`/`atob` rather than `Buffer`: `Buffer` needs `nodejs_compat`, and not
 * every consumer of this package enables it.
 */

/**
 * How many bytes are turned into characters per `String.fromCharCode` call.
 *
 * **This chunking is the entire reason this is not a one-liner.** Spreading a
 * whole image into `String.fromCharCode(...bytes)` passes one argument per
 * byte, and a multi-megabyte upload therefore overflows the call stack — a
 * `RangeError` thrown from inside what looks like a pure conversion, on large
 * inputs only, which is exactly the bug that survives every test written
 * against a small fixture. A reference image is user-supplied and uncapped, so
 * large inputs are the expected case here, not the edge one.
 *
 * 8192 is comfortably under every engine's argument limit and still only a few
 * hundred iterations per megabyte.
 */
const CHUNK_SIZE = 8192;

/** The bytes as a base64 string, safe for inputs of any size. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

/**
 * A `data:` URL for an image, the form every multimodal chat API accepts as an
 * `image_url`.
 *
 * `contentType` is taken from the caller rather than sniffed from the bytes.
 * This package has no image decoder, and a wrong guess produces a model call
 * that fails for a reason the error will not name.
 */
export function toDataUrl(bytes: Uint8Array, contentType: string): string {
  return `data:${contentType};base64,${bytesToBase64(bytes)}`;
}
