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

/** The Responses API request body the helper is expected to send. */
function expectedBody(overrides: Record<string, unknown> = {}) {
  return {
    input: "Generate a person",
    text: {
      format: {
        type: "json_schema",
        name: "output",
        schema: personSchema,
        strict: true,
      },
    },
    ...overrides,
  };
}

/**
 * A gpt-oss-120b reply. The `reasoning` item comes first deliberately: taking
 * output[0] rather than searching for the message item is the mistake this
 * fixture exists to catch.
 */
function responsesEnvelope(text: string) {
  return {
    output: [
      { type: "reasoning", summary: [] },
      { type: "message", content: [{ type: "output_text", text }] },
    ],
  };
}

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

  it("calls the model directly when no gateway is configured", async () => {
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(JSON.stringify({ name: "Ava", age: 30 })),
    };

    await getTextualModelOutput(
      personSchema,
      "Generate a person",
      "some-model",
      mockAi
    );

    expect(mockAi.run).toHaveBeenCalledWith(
      "some-model",
      expectedBody(),
      undefined
    );
  });

  it("routes through the gateway without caching when an id is configured", async () => {
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(JSON.stringify({ name: "Ava", age: 30 })),
    };

    await getTextualModelOutput(
      personSchema,
      "Generate a person",
      "some-model",
      mockAi,
      { gateway: { id: "helios" } }
    );

    expect(mockAi.run).toHaveBeenCalledWith(
      "some-model",
      expectedBody(),
      { gateway: { id: "helios" } }
    );
  });

  it("sends identical gateway options on every retry", async () => {
    const mockAi: AiRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({ name: "Ava" }))
        .mockResolvedValueOnce(JSON.stringify({ name: "Ava", age: 30 })),
    };

    await getTextualModelOutput(
      personSchema,
      "Generate a person",
      "some-model",
      mockAi,
      { gateway: { id: "helios" } }
    );

    const calls = vi.mocked(mockAi.run).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][2]).toEqual(calls[1][2]);
    expect(calls[0][2]).toEqual({ gateway: { id: "helios" } });
  });
});

describe("getTextualModelOutput response envelopes", () => {
  it("extracts the answer from a gpt-oss-120b Responses API reply", async () => {
    const mockAi: AiRunner = {
      run: vi
        .fn()
        .mockResolvedValue(
          responsesEnvelope(JSON.stringify({ name: "Ava", age: 30 }))
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

  it("retries rather than crashing when the output has no message item", async () => {
    const reasoningOnly = { output: [{ type: "reasoning", summary: [] }] };
    const mockAi: AiRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce(reasoningOnly)
        .mockResolvedValueOnce(
          responsesEnvelope(JSON.stringify({ name: "Ava", age: 30 }))
        ),
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

  it("treats truncated JSON in the message as a failed attempt", async () => {
    const mockAi: AiRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce(responsesEnvelope('{"name":"Ava","ag'))
        .mockResolvedValueOnce(
          responsesEnvelope(JSON.stringify({ name: "Ava", age: 30 }))
        ),
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

  it("unwraps a classic Workers AI { response } reply, string or object", async () => {
    const asString: AiRunner = {
      run: vi
        .fn()
        .mockResolvedValue({ response: JSON.stringify({ name: "Ava", age: 30 }) }),
    };
    const asObject: AiRunner = {
      run: vi.fn().mockResolvedValue({ response: { name: "Ava", age: 30 } }),
    };

    await expect(
      getTextualModelOutput(personSchema, "Generate a person", "m", asString)
    ).resolves.toEqual({ name: "Ava", age: 30 });

    await expect(
      getTextualModelOutput(personSchema, "Generate a person", "m", asObject)
    ).resolves.toEqual({ name: "Ava", age: 30 });
  });

  it("quotes the unusable response in the error, not just the ajv output", async () => {
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue({ unexpected: "envelope" }),
    };

    await expect(
      getTextualModelOutput(personSchema, "Generate a person", "m", mockAi)
    ).rejects.toThrow(/unexpected/);
  });
});

describe("getTextualModelOutput request body", () => {
  it("sends the schema to the model as text.format", async () => {
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(
        responsesEnvelope(JSON.stringify({ name: "Ava", age: 30 }))
      ),
    };

    await getTextualModelOutput(
      personSchema,
      "Generate a person",
      "some-model",
      mockAi
    );

    const [, body] = vi.mocked(mockAi.run).mock.calls[0];
    expect(body).toEqual(expectedBody());
  });

  it("sends instructions separately from the user input when given", async () => {
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(
        responsesEnvelope(JSON.stringify({ name: "Ava", age: 30 }))
      ),
    };

    await getTextualModelOutput(
      personSchema,
      "Generate a person",
      "some-model",
      mockAi,
      { instructions: "You are a person generator." }
    );

    const [, body] = vi.mocked(mockAi.run).mock.calls[0];
    expect(body).toEqual(
      expectedBody({ instructions: "You are a person generator." })
    );
  });

  it("omits the instructions key entirely when none is given", async () => {
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(
        responsesEnvelope(JSON.stringify({ name: "Ava", age: 30 }))
      ),
    };

    await getTextualModelOutput(
      personSchema,
      "Generate a person",
      "some-model",
      mockAi
    );

    const [, body] = vi.mocked(mockAi.run).mock.calls[0];
    expect(body).not.toHaveProperty("instructions");
  });

  it("uses a caller-supplied schema name", async () => {
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(
        responsesEnvelope(JSON.stringify({ name: "Ava", age: 30 }))
      ),
    };

    await getTextualModelOutput(
      personSchema,
      "Generate a person",
      "some-model",
      mockAi,
      { schemaName: "helios_params" }
    );

    const [, body] = vi.mocked(mockAi.run).mock.calls[0];
    expect((body as { text: { format: { name: string } } }).text.format.name).toBe(
      "helios_params"
    );
  });

  it("defaults to 2 attempts, matching MAX_RETRIES, not 3", async () => {
    const mockAi: AiRunner = {
      run: vi
        .fn()
        .mockResolvedValue(responsesEnvelope(JSON.stringify({ name: "Ava" }))),
    };

    await expect(
      getTextualModelOutput(personSchema, "Generate a person", "m", mockAi)
    ).rejects.toThrow(/2 attempt\(s\)/);

    expect(mockAi.run).toHaveBeenCalledTimes(2);
  });
});