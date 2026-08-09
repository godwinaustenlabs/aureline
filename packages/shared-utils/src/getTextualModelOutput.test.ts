import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { getTextualModelOutput, type AiRunner } from "./getTextualModelOutput";

const personSchema = z.object({
  name: z.string(),
  age: z.number(),
});

/**
 * The JSON Schema the helper derives from the Zod schema and sends to the
 * model, minus the `$schema` dialect key it strips.
 */
const { $schema: _dialect, ...personJsonSchema } = z.toJSONSchema(personSchema);

/** The Chat Completions request body the helper is expected to send. */
function expectedBody(overrides: { instructions?: string } = {}) {
  const messages: Record<string, unknown>[] = [];
  if (overrides.instructions) {
    messages.push({ role: "system", content: overrides.instructions });
  }
  messages.push({ role: "user", content: "Generate a person" });

  return {
    messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "output",
        schema: personJsonSchema,
        strict: true,
      },
    },
    max_tokens: 2048,
  };
}

/** A Chat Completions reply. */
function chatCompletionsEnvelope(text: string) {
  return {
    choices: [{ message: { content: text } }],
  };
}

describe("getTextualModelOutput", () => {
  it("returns parsed output when it matches the schema on the first try", async () => {
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(
        chatCompletionsEnvelope(JSON.stringify({ name: "Ava", age: 30 }))
      ),
    };

    const result = await getTextualModelOutput(
      personSchema,
      "Generate a person",
      "some-model",
      mockAi
    );

    expect(result.data).toEqual({ name: "Ava", age: 30 });
    expect(mockAi.run).toHaveBeenCalledTimes(1);
  });

  it("retries when output fails schema validation, then succeeds", async () => {
    const mockAi: AiRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce(chatCompletionsEnvelope(JSON.stringify({ name: "Ava" }))) // missing "age" -> invalid
        .mockResolvedValueOnce(chatCompletionsEnvelope(JSON.stringify({ name: "Ava", age: 30 }))), // valid
    };

    const result = await getTextualModelOutput(
      personSchema,
      "Generate a person",
      "some-model",
      mockAi
    );

    expect(result.data).toEqual({ name: "Ava", age: 30 });
    expect(mockAi.run).toHaveBeenCalledTimes(2);
  });

  it("throws an error after exhausting all retries on persistent schema drift", async () => {
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(chatCompletionsEnvelope(JSON.stringify({ name: "Ava" }))), // always invalid
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
      run: vi.fn().mockResolvedValue(chatCompletionsEnvelope(JSON.stringify({ name: "Ava", age: 30 }))),
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
      run: vi.fn().mockResolvedValue(chatCompletionsEnvelope(JSON.stringify({ name: "Ava", age: 30 }))),
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
        .mockResolvedValueOnce(chatCompletionsEnvelope(JSON.stringify({ name: "Ava" })))
        .mockResolvedValueOnce(chatCompletionsEnvelope(JSON.stringify({ name: "Ava", age: 30 }))),
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
  it("extracts the answer from a Chat Completions reply", async () => {
    const mockAi: AiRunner = {
      run: vi
        .fn()
        .mockResolvedValue(
          chatCompletionsEnvelope(JSON.stringify({ name: "Ava", age: 30 }))
        ),
    };

    const result = await getTextualModelOutput(
      personSchema,
      "Generate a person",
      "some-model",
      mockAi
    );

    expect(result.data).toEqual({ name: "Ava", age: 30 });
    expect(mockAi.run).toHaveBeenCalledTimes(1);
  });

  it("treats truncated JSON in the message as a failed attempt", async () => {
    const mockAi: AiRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce(chatCompletionsEnvelope('{"name":"Ava","ag'))
        .mockResolvedValueOnce(
          chatCompletionsEnvelope(JSON.stringify({ name: "Ava", age: 30 }))
        ),
    };

    const result = await getTextualModelOutput(
      personSchema,
      "Generate a person",
      "some-model",
      mockAi
    );

    expect(result.data).toEqual({ name: "Ava", age: 30 });
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

    const resultA = await getTextualModelOutput(personSchema, "Generate a person", "m", asString);
    expect(resultA.data).toEqual({ name: "Ava", age: 30 });

    const resultB = await getTextualModelOutput(personSchema, "Generate a person", "m", asObject);
    expect(resultB.data).toEqual({ name: "Ava", age: 30 });
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
  it("sends the schema to the model as response_format.json_schema", async () => {
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(
        chatCompletionsEnvelope(JSON.stringify({ name: "Ava", age: 30 }))
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

  it("sends instructions as a system message before the user input when given", async () => {
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(
        chatCompletionsEnvelope(JSON.stringify({ name: "Ava", age: 30 }))
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

  it("omits the system message entirely when no instructions are given", async () => {
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(
        chatCompletionsEnvelope(JSON.stringify({ name: "Ava", age: 30 }))
      ),
    };

    await getTextualModelOutput(
      personSchema,
      "Generate a person",
      "some-model",
      mockAi
    );

    const [, body] = vi.mocked(mockAi.run).mock.calls[0];
    const messages = (body as { messages: { role: string }[] }).messages;
    expect(messages.every((m) => m.role !== "system")).toBe(true);
  });

  it("uses a caller-supplied schema name", async () => {
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(
        chatCompletionsEnvelope(JSON.stringify({ name: "Ava", age: 30 }))
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
    expect(
      (body as { response_format: { json_schema: { name: string } } }).response_format.json_schema.name
    ).toBe("helios_params");
  });

  it("defaults to 2 attempts, matching MAX_RETRIES, not 3", async () => {
    const mockAi: AiRunner = {
      run: vi
        .fn()
        .mockResolvedValue(chatCompletionsEnvelope(JSON.stringify({ name: "Ava" }))),
    };

    await expect(
      getTextualModelOutput(personSchema, "Generate a person", "m", mockAi)
    ).rejects.toThrow(/2 attempt\(s\)/);

    expect(mockAi.run).toHaveBeenCalledTimes(2);
  });

  it("sets max_tokens so reasoning does not truncate the JSON output", async () => {
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(
        chatCompletionsEnvelope(JSON.stringify({ name: "Ava", age: 30 }))
      ),
    };

    await getTextualModelOutput(
      personSchema,
      "Generate a person",
      "some-model",
      mockAi,
      { maxOutputTokens: 4096 }
    );

    const [, body] = vi.mocked(mockAi.run).mock.calls[0];
    expect((body as { max_tokens: number }).max_tokens).toBe(4096);
  });

  it("sends temperature only when one is configured", async () => {
    const reply = chatCompletionsEnvelope(
      JSON.stringify({ name: "Ava", age: 30 })
    );

    const withTemperature: AiRunner = {
      run: vi.fn().mockResolvedValue(reply),
    };
    await getTextualModelOutput(
      personSchema,
      "Generate a person",
      "some-model",
      withTemperature,
      { temperature: 0.2 }
    );
    const [, configured] = vi.mocked(withTemperature.run).mock.calls[0];
    expect(configured).toHaveProperty("temperature", 0.2);

    // Absent means the model keeps its own default, so the key must not be
    // present at all rather than sent as undefined.
    const without: AiRunner = { run: vi.fn().mockResolvedValue(reply) };
    await getTextualModelOutput(
      personSchema,
      "Generate a person",
      "some-model",
      without
    );
    const [, omitted] = vi.mocked(without.run).mock.calls[0];
    expect(omitted).not.toHaveProperty("temperature");
  });
});