import Ajv, { type Schema } from "ajv";
import {
  buildAiRunOptions,
  type AiRunOptions,
  type GatewayConfig,
} from "./aiGateway";

const ajv = new Ajv();

/** Default attempts, matching `MAX_RETRIES` in agent-helios' wrangler.jsonc. */
const DEFAULT_MAX_RETRIES = 2;

/** How much of an unusable response to quote back in the thrown error. */
const RESPONSE_EXCERPT_LENGTH = 200;

/**
 * Options to control retry behavior when the model's output
 * fails schema validation.
 */
export interface GetTextualModelOutputOptions {
  /**
   * System prompt, sent as the Responses API's `instructions` field — separate
   * from the user input in `prompt`. Responses-API models treat the two
   * differently: instructions are stable across requests, input is not.
   * Omitted entirely when not provided, rather than sent as undefined.
   */
  instructions?: string;
  /** Name attached to the schema in `text.format`. Defaults to "output". */
  schemaName?: string;
  /**
   * Maximum number of attempts before giving up (default: 2).
   *
   * Expected to come from runtime config — the default is a fallback for
   * standalone use, not a policy. Every attempt is a billed model call.
   */
  maxRetries?: number;
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
 * Order matters. The Responses-API check has to come first: those replies are
 * objects, so they would otherwise fall through to the "already an object"
 * case and be validated as-is — which is the envelope-never-opened bug this
 * function exists to fix.
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

  // Responses API (gpt-oss-120b): find the `message` item rather than taking
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

/**
 * Calls a model with a prompt and returns output validated against
 * the given JSON schema. Retries on schema drift (invalid output).
 * Throws an error if all retries are exhausted without valid output,
 * so the pipeline can catch it upstream.
 *
 * Sends the schema to the model as `text.format`, so the output is
 * schema-guided rather than merely schema-checked. This is the Responses API
 * request shape (`instructions` + `input`), which is what `gpt-oss-120b`
 * expects — chat-completions models that want `messages` + `response_format`
 * are deliberately not supported. See
 * docs/adr/0007-responses-api-only-for-structured-output.md.
 */
export async function getTextualModelOutput<T = unknown>(
  schema: Schema,
  prompt: string,
  model: string,
  ai: AiRunner,
  options: GetTextualModelOutputOptions = {}
): Promise<T> {
  const {
    instructions,
    schemaName = "output",
    maxRetries = DEFAULT_MAX_RETRIES,
    gateway,
  } = options;
  const validate = ajv.compile(schema);

  // Both built once, outside the loop: every attempt is the same call routed
  // the same way, so the gateway sees one consistent request shape.
  const body: Record<string, unknown> = {
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        schema,
        strict: true,
      },
    },
  };
  if (instructions) {
    body.instructions = instructions;
  }

  const runOptions = buildAiRunOptions(gateway);

  let lastError: unknown;
  let lastResponse: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await ai.run(model, body, runOptions);
      lastResponse = response;

      const parsed = extractStructuredOutput(response);

      if (validate(parsed)) {
        return parsed as T;
      }

      lastError = validate.errors;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `getTextualModelOutput: schema validation failed after ${maxRetries} attempt(s). ` +
      `Last error: ${JSON.stringify(lastError)}. ` +
      `Last response: ${excerpt(lastResponse)}`
  );
}
