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

  it("reports a thrown call as a call failure, not as schema drift", async () => {
    // The loop swallows a thrown `ai.run` into the same `lastError` as a schema
    // mismatch. Reporting both the same way records a bad model name or a
    // network error as a schema problem, and `JSON.stringify` on an Error gives
    // `{}`, so the message would carry no detail at all. This is the exact
    // failure ticket 08's forced-failure verification produces.
    const mockAi: AiRunner = {
      run: vi.fn().mockRejectedValue(new Error("No such model @cf/does/not-exist")),
    };

    await expect(
      getTextualModelOutput(
        personSchema,
        "Generate a person",
        "@cf/does/not-exist",
        mockAi,
        { maxRetries: 2 }
      )
    ).rejects.toThrow(/model call failed after 2 attempt\(s\): No such model/);

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

  describe("reference images", () => {
    const reply = chatCompletionsEnvelope(JSON.stringify({ name: "Ava", age: 30 }));

    /** A real 4-byte image. Small, but a genuine `Uint8Array`, not a stand-in. */
    const pixel = new Uint8Array([137, 80, 78, 71]);

    /** Sends one call and hands back the body the helper actually built. */
    async function bodySentWith(
      options: Parameters<typeof getTextualModelOutput>[4],
    ): Promise<Record<string, unknown>> {
      const mockAi: AiRunner = { run: vi.fn().mockResolvedValue(reply) };
      await getTextualModelOutput(
        personSchema,
        "Generate a person",
        "some-model",
        mockAi,
        options,
      );
      const [, body] = vi.mocked(mockAi.run).mock.calls[0];
      return body;
    }

    it("sends the identical text-only body when no images are given", async () => {
      // The regression promise, and the reason it is asserted against the whole
      // body rather than one field: a request with no reference image has to be
      // exactly what it was before this option existed, not merely equivalent.
      expect(await bodySentWith({})).toEqual(expectedBody());
    });

    it("sends the identical text-only body when images is an empty array", async () => {
      // A caller with nothing to attach passes `[]` rather than branching, and
      // must get today's request rather than a needlessly different one.
      expect(await bodySentWith({ images: [] })).toEqual(expectedBody());
    });

    it("sends a parts array with the text first and a data URL per image", async () => {
      const body = await bodySentWith({
        images: [{ bytes: pixel, contentType: "image/png" }],
      });

      const [message] = body.messages as { role: string; content: unknown }[];
      expect(message.role).toBe("user");
      expect(message.content).toEqual([
        { type: "text", text: "Generate a person" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==" } },
      ]);
    });

    it("carries each image's own content type", async () => {
      const body = await bodySentWith({
        images: [
          { bytes: pixel, contentType: "image/png" },
          { bytes: new Uint8Array([255, 216, 255]), contentType: "image/jpeg" },
        ],
      });

      const [message] = body.messages as { content: { image_url?: { url: string } }[] }[];
      const urls = message.content
        .filter((part) => part.image_url !== undefined)
        .map((part) => part.image_url!.url);

      expect(urls).toEqual([
        "data:image/png;base64,iVBORw==",
        "data:image/jpeg;base64,/9j/",
      ]);
    });

    it("leaves the system message a bare string when images are present", async () => {
      // Only the user message becomes multimodal. A system message that turned
      // into a parts array is rejected by some providers, and the failure names
      // neither the message nor the reason.
      const body = await bodySentWith({
        instructions: "You are a planner",
        images: [{ bytes: pixel, contentType: "image/png" }],
      });

      const [system] = body.messages as { role: string; content: unknown }[];
      expect(system).toEqual({ role: "system", content: "You are a planner" });
    });
  });
});
describe("getTextualModelOutput when the model wraps its JSON in prose", () => {
  const warn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("recovers JSON behind a markdown heading, the exact llama-vision failure", async () => {
    const spy = warn();
    // Verbatim shape of the production failure: the reply began "**Solution",
    // `JSON.parse` threw on the first `*`, and a correct answer that had already
    // been paid for was discarded three times over.
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(
        chatCompletionsEnvelope(
          `**Solution**\n\n${JSON.stringify({ name: "Ava", age: 30 })}`
        )
      ),
    };

    const result = await getTextualModelOutput(personSchema, "Generate a person", "m", mockAi);

    expect(result.data).toEqual({ name: "Ava", age: 30 });
    // One call, not three. The recovery has to happen on the first attempt or
    // it has not saved anything.
    expect(mockAi.run).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("recovers JSON inside a markdown fence", async () => {
    const spy = warn();
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(
        chatCompletionsEnvelope('```json\n{"name":"Ava","age":30}\n```')
      ),
    };

    const result = await getTextualModelOutput(personSchema, "Generate a person", "m", mockAi);

    expect(result.data).toEqual({ name: "Ava", age: 30 });
    spy.mockRestore();
  });

  it("warns, because a model ignoring response_format is a fact worth seeing", async () => {
    const spy = warn();
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(
        chatCompletionsEnvelope('Here you go:\n{"name":"Ava","age":30}')
      ),
    };

    await getTextualModelOutput(personSchema, "Generate a person", "m", mockAi);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("not honouring response_format"));
    spy.mockRestore();
  });

  it("does not warn when the model behaves", async () => {
    const spy = warn();
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(
        chatCompletionsEnvelope(JSON.stringify({ name: "Ava", age: 30 }))
      ),
    };

    await getTextualModelOutput(personSchema, "Generate a person", "m", mockAi);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("never repairs malformed JSON into something that merely looks valid", async () => {
    const spy = warn();
    // A trailing comma. Repairing this is where "tolerant parsing" turns a model
    // that is wrong into a model that looks right — far worse than a failed run,
    // because nothing downstream can tell.
    const mockAi: AiRunner = {
      run: vi.fn().mockResolvedValue(chatCompletionsEnvelope('{"name":"Ava","age":30,}')),
    };

    await expect(
      getTextualModelOutput(personSchema, "Generate a person", "m", mockAi, { maxRetries: 1 })
    ).rejects.toThrow();
    spy.mockRestore();
  });
});

describe("getTextualModelOutput retries", () => {
  it("tells the model what was wrong instead of repeating the same call", async () => {
    // The defect this pins: `body` was built once outside the loop, so all three
    // attempts were byte-identical and the model was never told anything had
    // failed. `max_retries` multiplied the bill and changed nothing else.
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = vi
      .fn()
      .mockResolvedValueOnce(chatCompletionsEnvelope("I cannot help with that."))
      .mockResolvedValueOnce(chatCompletionsEnvelope(JSON.stringify({ name: "Ava", age: 30 })));

    const result = await getTextualModelOutput(
      personSchema,
      "Generate a person",
      "m",
      { run },
      { maxRetries: 2 }
    );

    expect(result.data).toEqual({ name: "Ava", age: 30 });

    const second = run.mock.calls[1][1] as { messages: { role: string; content: unknown }[] };
    // The failed answer went back as an assistant turn, and the correction as a
    // user turn after it.
    // The original user turn, the failed answer, and the correction. No
    // `instructions` were passed, so there is no system message ahead of them.
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toEqual({ role: "assistant", content: "I cannot help with that." });
    expect(second.messages[2]?.role).toBe("user");
    expect(second.messages[2]?.content).toContain("not valid JSON");
    spy.mockRestore();
  });

  it("names the schema problems when the JSON parsed but the shape was wrong", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(chatCompletionsEnvelope(JSON.stringify({ name: "Ava", age: "thirty" })))
      .mockResolvedValueOnce(chatCompletionsEnvelope(JSON.stringify({ name: "Ava", age: 30 })));

    await getTextualModelOutput(personSchema, "Generate a person", "m", { run }, { maxRetries: 2 });

    const second = run.mock.calls[1][1] as { messages: { content: unknown }[] };
    // A different correction from the JSON one: "valid JSON, wrong shape" and
    // "not JSON at all" are not the same note to send back.
    expect(second.messages[2]?.content).toContain("did not match the required schema");
    expect(second.messages[2]?.content).toContain("age");
  });

  it("sends the first attempt unchanged, so a call that succeeds is untouched", async () => {
    const run = vi
      .fn()
      .mockResolvedValue(chatCompletionsEnvelope(JSON.stringify({ name: "Ava", age: 30 })));

    await getTextualModelOutput(personSchema, "Generate a person", "m", { run });

    expect(run).toHaveBeenCalledWith("m", expectedBody(), undefined);
  });

  it("reports a model that answered with prose as a schema failure, not a call failure", async () => {
    // The misattribution that sent this debugging session to the wrong half of
    // the system. `JSON.parse` throwing inside the try was caught as a *call*
    // failure, so a model that answered perfectly well over a healthy connection
    // was reported as "model call failed".
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = vi.fn().mockResolvedValue(chatCompletionsEnvelope("**Solution** but no JSON here"));

    await expect(
      getTextualModelOutput(personSchema, "Generate a person", "m", { run }, { maxRetries: 2 })
    ).rejects.toThrow(/schema validation failed/);
    spy.mockRestore();
  });
});
