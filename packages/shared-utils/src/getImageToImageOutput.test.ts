import { describe, it, expect, vi } from "vitest";
import {
  getImageToImageOutput,
  MAX_INPUT_IMAGE_DIMENSION,
  MAX_INPUT_IMAGES,
  type InputImage,
} from "./getImageToImageOutput";
import { type ImageAiRunner } from "./getImageModelOutput";
import { DEFAULT_IMAGE_CACHE_TTL } from "./aiGateway";

/** base64 for the bytes [72, 101, 108, 108, 111] ("Hello"). */
const BASE64_IMAGE = "SGVsbG8=";
const DECODED_BYTES = [72, 101, 108, 108, 111];

const MODEL = "@cf/black-forest-labs/flux-2-klein-9b";

/** A complete, valid reference image. No dimensions declared. */
function motif(overrides: Partial<InputImage> = {}): InputImage {
  return {
    bytes: new Uint8Array([1, 2, 3, 4]),
    contentType: "image/jpeg",
    ...overrides,
  };
}

function fakeAi(response: unknown = { image: BASE64_IMAGE }): ImageAiRunner {
  return { run: vi.fn().mockResolvedValue(response) };
}

/**
 * Reads the multipart body back off a captured `ai.run` call, so the field
 * names are asserted against what was actually serialized rather than against
 * the construction code that produced it.
 */
async function parseSentForm(ai: ImageAiRunner): Promise<FormData> {
  const call = vi.mocked(ai.run).mock.calls[0];
  if (!call) {
    throw new Error("ai.run was never called");
  }

  const [, input] = call;
  const multipart = (input as { multipart?: { body?: unknown; contentType?: unknown } })
    .multipart;

  if (!multipart || !multipart.body || typeof multipart.contentType !== "string") {
    throw new Error("ai.run did not receive a multipart body");
  }

  if (!(multipart.body instanceof ReadableStream)) {
    throw new Error("multipart body was not a ReadableStream");
  }

  return await new Response(multipart.body, {
    headers: { "content-type": multipart.contentType },
  }).formData();
}

describe("getImageToImageOutput", () => {
  it("sends a multipart body and decodes the base64 response into bytes", async () => {
    const ai = fakeAi();

    const result = await getImageToImageOutput(
      "recolor this motif in navy and gold",
      [motif()],
      MODEL,
      ai
    );

    expect(result.contentType).toBe("image/jpeg");
    expect(Array.from(result.image)).toEqual(DECODED_BYTES);

    expect(ai.run).toHaveBeenCalledTimes(1);
    const [model, input, options] = vi.mocked(ai.run).mock.calls[0] ?? [];

    expect(model).toBe(MODEL);
    // No gateway id was given, so no gateway options are sent at all.
    expect(options).toBeUndefined();
    expect(input).toMatchObject({
      multipart: {
        body: expect.any(ReadableStream),
        contentType: expect.stringContaining("multipart/form-data; boundary="),
      },
    });
  });

  it("names the reference images input_image_0 upward and carries the prompt", async () => {
    const ai = fakeAi();

    await getImageToImageOutput(
      "recolor this motif in navy and gold",
      [motif(), motif({ bytes: new Uint8Array([9, 9]) })],
      MODEL,
      ai
    );

    const form = await parseSentForm(ai);

    expect(form.get("prompt")).toBe("recolor this motif in navy and gold");
    expect(form.get("input_image_0")).toBeInstanceOf(Blob);
    expect(form.get("input_image_1")).toBeInstanceOf(Blob);
    expect(form.get("input_image_2")).toBeNull();
    // The name we used to send, and which the model silently ignored.
    expect(form.get("image")).toBeNull();

    const first = form.get("input_image_0");
    if (!(first instanceof Blob)) {
      throw new Error("input_image_0 was not a Blob");
    }
    expect(first.type).toBe("image/jpeg");
    expect(Array.from(new Uint8Array(await first.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  it("merges extras into the form as strings", async () => {
    const ai = fakeAi();

    await getImageToImageOutput("a motif", [motif()], MODEL, ai, {
      extras: { width: "1024", height: "1024" },
    });

    const form = await parseSentForm(ai);

    expect(form.get("width")).toBe("1024");
    expect(form.get("height")).toBe("1024");
  });

  it("rejects more input images than the model accepts, without calling the model", async () => {
    const ai = fakeAi();
    const tooMany = Array.from({ length: MAX_INPUT_IMAGES + 1 }, () => motif());

    await expect(
      getImageToImageOutput("a motif", tooMany, MODEL, ai)
    ).rejects.toThrow(/at most 4 input images, but 5 were given/i);

    expect(ai.run).not.toHaveBeenCalled();
  });

  it("rejects an oversized image without calling the model", async () => {
    const ai = fakeAi();

    await expect(
      getImageToImageOutput(
        "a motif",
        [motif({ width: 640, height: 640 })],
        MODEL,
        ai
      )
    ).rejects.toThrow(/input image 0 is 640x640/i);

    // The point of this assertion: an error thrown *after* the call still
    // bills. The guard is worthless unless it runs first.
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("rejects an image at exactly the limit", async () => {
    const ai = fakeAi();

    await expect(
      getImageToImageOutput(
        "a motif",
        [motif({ width: MAX_INPUT_IMAGE_DIMENSION, height: 128 })],
        MODEL,
        ai
      )
    ).rejects.toThrow(/at or above the 512px limit/i);

    expect(ai.run).not.toHaveBeenCalled();
  });

  it("calls the model when an image declares no dimensions", async () => {
    const ai = fakeAi();

    // iris-06 sent a 640x640 input and the model accepted it silently. A caller
    // that does not know its dimensions must not be blocked by a bound the
    // model does not actually enforce.
    const result = await getImageToImageOutput("a motif", [motif()], MODEL, ai);

    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(Array.from(result.image)).toEqual(DECODED_BYTES);
  });

  it("throws when the model response has no image field", async () => {
    const ai = fakeAi({});

    await expect(
      getImageToImageOutput("a motif", [motif()], MODEL, ai)
    ).rejects.toThrow(/did not return an image/i);
  });

  it("distinguishes the call failing from the response being unusable", async () => {
    const ai: ImageAiRunner = {
      run: vi.fn().mockRejectedValue(new Error("8001: Invalid input")),
    };

    await expect(
      getImageToImageOutput("a motif", [motif()], MODEL, ai)
    ).rejects.toThrow(/the call to model .* failed: 8001: Invalid input/i);
  });

  it("passes gateway options through when an id is configured", async () => {
    const ai = fakeAi();

    await getImageToImageOutput("a motif", [motif()], MODEL, ai, {
      gateway: { id: "iris", skipCache: true, metadata: { pipeline_id: "run-a" } },
    });

    const [, , options] = vi.mocked(ai.run).mock.calls[0] ?? [];

    expect(options).toEqual({
      gateway: {
        id: "iris",
        cacheTtl: DEFAULT_IMAGE_CACHE_TTL,
        skipCache: true,
        metadata: { pipeline_id: "run-a" },
      },
    });
  });

  it("sends no gateway options when the id is empty", async () => {
    const ai = fakeAi();

    await getImageToImageOutput("a motif", [motif()], MODEL, ai, {
      gateway: { id: "" },
    });

    const [, , options] = vi.mocked(ai.run).mock.calls[0] ?? [];

    expect(options).toBeUndefined();
  });
});
