import { z, type ZodType } from "zod";
import {
  buildAiRunOptions,
  type AiRunOptions,
  type GatewayConfig,
} from "./aiGateway";

/** Default attempts, matching `MAX_RETRIES` in agent-helios' wrangler.jsonc. */
const DEFAULT_MAX_RETRIES = 2;

/** Default cap on completion tokens. Chat Completions defaults to 256, which
 * the model can burn entirely on reasoning before writing the answer,
 * truncating the JSON mid-object. Set well above observed reasoning + output. */
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/** How much of an unusable response to quote back in the thrown error. */
const RESPONSE_EXCERPT_LENGTH = 200;

/**
 * Options to control retry behavior when the model's output
 * fails schema validation.
 */
export interface GetTextualModelOutputOptions {
  /**
   * System prompt, sent as the `system` message in the Chat Completions
   * request. Omitted entirely when not provided, rather than sent as undefined.
   */
  instructions?: string;
  /** Name attached to the schema in `response_format`. Defaults to "output". */
  schemaName?: string;
  /**
   * Maximum number of attempts before giving up (default: 2).
   *
   * Expected to come from runtime config — the default is a fallback for
   * standalone use, not a policy. Every attempt is a billed model call.
   */
  maxRetries?: number;
  /**
   * Cap on completion tokens (default: 2048). Chat Completions models spend
   * part of this budget on reasoning before the visible answer, so this must
   * be well above the expected JSON output size or the response truncates
   * mid-object.
   */
  maxOutputTokens?: number;
  /**
   * Sampling temperature. Omitted entirely when not provided, leaving the
   * model's own default in place rather than sending `undefined`.
   *
   * Expected to come from runtime config alongside the model id, since the
   * useful value depends on which model is being called.
   */
  temperature?: number;
  /**
   * Route the call through AI Gateway. Omit the id (or leave it empty) to
   * call Workers AI directly. No cacheTtl is applied by default: every retry
   * must reach the model for real, otherwise the retry loop would replay a
   * cached invalid response.
   */
  gateway?: GatewayConfig;
}

/**
 * Minimal interface for the model-calling client this helper needs.
 * In Cloudflare Workers, this is typically `env.AI`.
 */
export interface AiRunner {
  run: (
    model: string,
    input: Record<string, unknown>,
    options?: AiRunOptions
  ) => Promise<unknown>;
}

/**
 * Pulls the model's actual answer out of whatever envelope it arrived in.
 *
 * Order matters. The Chat Completions check (`choices`) and Responses API
 * check (`output`) both come before the generic object case, since either
 * would otherwise be validated as-is without opening the envelope.
 *
 * Anything unrecognised is handed back untouched so Ajv produces the error,
 * rather than this throwing a shape error of its own.
 */
function extractStructuredOutput(response: unknown): unknown {
  if (typeof response === "string") {
    return JSON.parse(response);
  }

  if (!response || typeof response !== "object") {
    return response;
  }

  // Chat Completions shape: { choices: [{ message: { content } }] }.
  const { choices } = response as { choices?: unknown };
  if (Array.isArray(choices)) {
    const first = choices[0] as { message?: { content?: unknown } } | undefined;
    const text = first?.message?.content;
    return typeof text === "string" ? JSON.parse(text) : response;
  }

  // Responses API (legacy path): find the `message` item rather than taking
  // output[0] — a `reasoning` item precedes it.
  const { output } = response as { output?: unknown };
  if (Array.isArray(output)) {
    const text = findMessageText(output);
    return typeof text === "string" ? JSON.parse(text) : response;
  }

  // Classic Workers AI text models: { response: string | object }.
  if ("response" in response) {
    const inner = (response as { response: unknown }).response;
    return typeof inner === "string" ? JSON.parse(inner) : inner;
  }

  return response;
}

/** First text payload of the first `message` item in a Responses API output. */
function findMessageText(output: unknown[]): string | undefined {
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if ((item as { type?: unknown }).type !== "message") continue;

    const { content } = item as { content?: unknown };
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      const text = (part as { text?: unknown })?.text;
      if (typeof text === "string") return text;
    }
  }

  return undefined;
}

/** Truncated, quotable form of a response, for error messages. */
function excerpt(response: unknown): string {
  const asText =
    typeof response === "string" ? response : JSON.stringify(response);

  if (typeof asText !== "string") return String(response);

  return asText.length > RESPONSE_EXCERPT_LENGTH
    ? `${asText.slice(0, RESPONSE_EXCERPT_LENGTH)}...`
    : asText;
}

/** Usage as actually reported by the model. Zero-valued usage means the
 * provider did not report real numbers for this call shape, so it is not
 * trustworthy cost data — callers should treat it as absent, not as zero. */
export interface TextualModelOutput<T> {
  data: T;
  usage: unknown;
  model: string;
}

/**
 * Calls a model with a prompt and returns output validated against
 * the given Zod schema. Retries on schema drift (invalid output).
 * Throws an error if all retries are exhausted without valid output,
 * so the pipeline can catch it upstream.
 *
 * Takes a Zod schema rather than raw JSON Schema for two reasons. Zod
 * validates by walking the value, where Ajv compiles a validator with
 * `new Function` — which Cloudflare Workers forbid outright, so the Ajv
 * version could not run in the runtime it ships to. And the repo's contracts
 * are already Zod (`@aureline/shared-types`), so callers pass the schema they
 * have instead of maintaining a second copy by hand. The JSON Schema sent to
 * the model is derived with `z.toJSONSchema`.
 *
 * Uses the Chat Completions request shape (`messages` + `response_format`),
 * not the Responses API shape (`input` + `text.format`). The Responses shape
 * does not report real token/neuron usage for this model — usage always
 * comes back zeroed, even though the call is billed. Chat Completions
 * reports real usage, so it is the only shape that makes cost trackable.
 */
export async function getTextualModelOutput<T extends ZodType>(
  schema: T,
  prompt: string,
  model: string,
  ai: AiRunner,
  options: GetTextualModelOutputOptions = {}
): Promise<TextualModelOutput<z.infer<T>>> {
  const {
    instructions,
    schemaName = "output",
    maxRetries = DEFAULT_MAX_RETRIES,
    maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
    temperature,
    gateway,
  } = options;

  // `$schema` is metadata about the dialect, not part of the shape, and
  // providers reject unknown keys inside a json_schema format block.
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema);

  const messages: Record<string, unknown>[] = [];
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }
  messages.push({ role: "user", content: prompt });

  // Built once, outside the loop: every attempt is the same call routed the
  // same way, so the gateway sees one consistent request shape.
  const body: Record<string, unknown> = {
    messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: schemaName,
        schema: jsonSchema,
        strict: true,
      },
    },
    max_tokens: maxOutputTokens,
  };

  // Sent only when configured, so an absent value leaves the model's own
  // default rather than pinning it to ours.
  if (temperature !== undefined) {
    body.temperature = temperature;
  }

  const runOptions = buildAiRunOptions(gateway);

  let lastError: unknown;
  let lastResponse: unknown;

  // Which kind of failure the last attempt was. The loop catches two genuinely
  // different things and they cannot share one message: a thrown call (bad model
  // name, network, rate limit) never produced a response to validate at all, and
  // `JSON.stringify` renders an `Error` as `{}`, so reporting one as a schema
  // problem records a transport failure with no detail whatsoever.
  let lastFailure: "schema" | "call" = "schema";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await ai.run(model, body, runOptions);
      lastResponse = response;

      const parsed = extractStructuredOutput(response);

      const result = schema.safeParse(parsed);
      if (result.success) {
        const usage = (response as { usage?: unknown })?.usage;
        return { data: result.data, usage, model };
      }

      lastError = result.error.issues;
      lastFailure = "schema";
    } catch (err) {
      lastError = err;
      lastFailure = "call";
    }
  }

  if (lastFailure === "call") {
    throw new Error(
      `getTextualModelOutput: model call failed after ${maxRetries} attempt(s): ` +
        `${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  }

  throw new Error(
    `getTextualModelOutput: schema validation failed after ${maxRetries} attempt(s). ` +
      `Last error: ${JSON.stringify(lastError)}. ` +
      `Last response: ${excerpt(lastResponse)}`
  );
}