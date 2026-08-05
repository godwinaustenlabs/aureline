import { describe, it, expect, vi } from "vitest";
import { getImageModelOutput, type ImageAiRunner } from "./getImageModelOutput";

describe("getImageModelOutput", () => {
  it("decodes a base64 image response into bytes", async () => {
    // base64 for the bytes [72, 101, 108, 108, 111] ("Hello")
    const base64Image = "SGVsbG8=";
    const mockAi: ImageAiRunner = {
      run: vi.fn().mockResolvedValue({ image: base64Image }),
    };

    const result = await getImageModelOutput(
      "a red fox",
      "@cf/black-forest-labs/flux-1-schnell",
      mockAi
    );

    expect(result.contentType).toBe("image/jpeg");
    expect(Array.from(result.image)).toEqual([72, 101, 108, 108, 111]);
    expect(mockAi.run).toHaveBeenCalledWith(
      "@cf/black-forest-labs/flux-1-schnell",
      { prompt: "a red fox" }
    );
  });

  it("forwards extra input options to the model call", async () => {
    const mockAi: ImageAiRunner = {
      run: vi.fn().mockResolvedValue({ image: "AA==" }),
    };

    await getImageModelOutput("a red fox", "some-model", mockAi, {
      steps: 4,
    });

    expect(mockAi.run).toHaveBeenCalledWith("some-model", {
      prompt: "a red fox",
      steps: 4,
    });
  });

  it("throws when the model response has no image field", async () => {
    const mockAi: ImageAiRunner = {
      run: vi.fn().mockResolvedValue({}),
    };

    await expect(
      getImageModelOutput("a red fox", "some-model", mockAi)
    ).rejects.toThrow(/did not return an image/i);
  });
});
