import { describe, it, expect, vi } from "vitest";
import { getTextualModelOutput, type AiRunner } from "./getTextualModelOutput";

const personSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "number" },
  },
  required: ["name", "age"],
  additionalProperties: false,
};

describe("getTextualModelOutput", () => {
  it("returns parsed output when it matches the schema on the first try", async () => {
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(
        JSON.stringify({ name: "Ava", age: 30 })
      ),
    };

    const result = await getTextualModelOutput(
      personSchema,
      "Generate a person",
      "some-model",
      mockAi
    );

    expect(result).toEqual({ name: "Ava", age: 30 });
    expect(mockAi.run).toHaveBeenCalledTimes(1);
  });

  it("retries when output fails schema validation, then succeeds", async () => {
    const mockAi: AiRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({ name: "Ava" })) // missing "age" -> invalid
        .mockResolvedValueOnce(JSON.stringify({ name: "Ava", age: 30 })), // valid
    };

    const result = await getTextualModelOutput(
      personSchema,
      "Generate a person",
      "some-model",
      mockAi
    );

    expect(result).toEqual({ name: "Ava", age: 30 });
    expect(mockAi.run).toHaveBeenCalledTimes(2);
  });

  it("throws an error after exhausting all retries on persistent schema drift", async () => {
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(JSON.stringify({ name: "Ava" })), // always invalid
    };

    await expect(
      getTextualModelOutput(
        personSchema,
        "Generate a person",
        "some-model",
        mockAi,
        { maxRetries: 2 }
      )
    ).rejects.toThrow(/schema validation failed/i);

    expect(mockAi.run).toHaveBeenCalledTimes(2);
  });
});