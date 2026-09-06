import { z, type ZodType } from "zod";
import {
  buildAiRunOptions,
  type AiRunOptions,
  type GatewayConfig,
} from "./aiGateway";
import { toDataUrl } from "./base64";
// Reused rather than redeclared: an image handed to a planner and an image
// handed to an image model are the same thing, and two interfaces with the same
// fields would drift.
import type { InputImage } from "./getImageToImageOutput";

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
  /**
   * Reference images sent alongside the prompt, making this a multimodal call.
   *
   * **Absent or empty, the request body is byte-for-byte what it has always
   * been** — `content` a bare string. That is not an optimisation, it is the
   * regression promise: every existing text-only call must keep producing the
   * identical request, so nothing about today's planner behaviour changes on
   * the day this option is added.
   *
   * The model must be vision-capable. A text-only model given image parts will
   * either ignore them or reject the call, and neither failure names the cause
   * — which is why the engines resolve a separate `vision_planner_model` rather
   * than hoping the configured planner happens to handle images.
   *
   * This hop was never affected by the AI Gateway's multipart restriction
   * (ADR-SHARED-0001). That restriction is about `ai.run` bodies containing a
   * `ReadableStream`; this is an ordinary JSON body with a base64 string in it,
   * and it routes through the gateway like any other.
   */
  images?: InputImage[];
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
    return parseModelJson(response);
  }

  if (!response || typeof response !== "object") {
    return response;
  }

  // Chat Completions shape: { choices: [{ message: { content } }] }.
  const { choices } = response as { choices?: unknown };
  if (Array.isArray(choices)) {
    const first = choices[0] as { message?: { content?: unknown } } | undefined;
    const text = first?.message?.content;
    return typeof text === "string" ? parseModelJson(text) : response;
  }

  // Responses API (legacy path): find the `message` item rather than taking
  // output[0] — a `reasoning` item precedes it.
  const { output } = response as { output?: unknown };
  if (Array.isArray(output)) {
    const text = findMessageText(output);
    return typeof text === "string" ? parseModelJson(text) : response;
  }

  // Classic Workers AI text models: { response: string | object }.
  if ("response" in response) {
    const inner = (response as { response: unknown }).response;
    return typeof inner === "string" ? parseModelJson(inner) : inner;
  }

  return response;
}

/**
 * Parses the model's answer, recovering JSON that arrived wrapped in prose.
 *
 * A strict `JSON.parse` first, and that is the path every well-behaved reply
 * takes — the recovery below never runs for a model that honours
 * `response_format: json_schema`.
 *
 * The recovery exists because not all of them do. `llama-3.2-11b-vision-instruct`
 * accepts the `json_schema` block, produces output matching the schema, and
 * intermittently prefixes it with markdown — a ```json fence, or a heading like
 * `**Solution**`. The JSON is right there and correct; a bare `JSON.parse` throws
 * on the first `*` and the whole billed call is discarded.
 *
 * **Deliberately narrow.** It takes the outermost `{...}` span and parses that,
 * with no repair of the JSON itself: no quote-fixing, no trailing-comma
 * stripping, no brace-balancing. Those turn a model that is wrong into a model
 * that looks right, which is far worse than a failed run. If the span between
 * the first `{` and the last `}` is not valid JSON on its own, this throws like
 * before.
 *
 * **Never silent.** Recovery means the model disobeyed the schema contract and
 * we compensated, which is a fact about the model worth seeing in the logs —
 * especially before choosing to keep it.
 */
function parseModelJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (strictError) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    // Rethrow the *original* error, not one about the span. The strict failure
    // is what actually describes the reply.
    if (start === -1 || end <= start) throw strictError;

    const span = text.slice(start, end + 1);
    const recovered: unknown = JSON.parse(span);

    console.warn(
      `getTextualModelOutput: the model wrapped its JSON in ${start} characters of ` +
        `prose — recovered it, but this model is not honouring response_format. ` +
        `Prefix: ${JSON.stringify(text.slice(0, Math.min(start, 80)))}`
    );

    return recovered;
  }
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

/**
 * The user message's `content`: a bare string, or the parts array a multimodal
 * call needs.
 *
 * The two branches are kept apart rather than always building an array with one
 * text part in it. A parts array is the *equivalent* shape for a text-only call,
 * not the *same* one, and some providers treat them differently — so a call with
 * no images must send exactly what it sent before this function existed. An
 * empty array counts as no images for the same reason: a caller that passes
 * `images: []` because it had nothing to attach gets today's request, not a
 * needlessly different one.
 *
 * The text part leads. The prompt is the instruction and the images are what it
 * refers to, and a model reading the instruction first is the ordering every
 * multimodal example uses.
 */
function buildUserContent(
  prompt: string,
  images: InputImage[] | undefined
): unknown {
  if (!images || images.length === 0) {
    return prompt;
  }

  return [
    { type: "text", text: prompt },
    ...images.map((image) => ({
      type: "image_url",
      image_url: { url: toDataUrl(image.bytes, image.contentType) },
    })),
  ];
}

/**
 * The model's own words out of whatever envelope carried them.
 *
 * Used only to echo a failed answer back to the model. It deliberately does not
 * parse: this is the text as the model wrote it, prose and all, because the
 * point of echoing it is to show the model the thing it is being asked to fix.
 * Falls back to the serialized envelope when no text field is recognisable,
 * which is still more use to the model than nothing.
 */
function responseText(response: unknown): string {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return String(response);

  const { choices } = response as { choices?: unknown };
  if (Array.isArray(choices)) {
    const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
    if (typeof content === "string") return content;
  }

  const { output } = response as { output?: unknown };
  if (Array.isArray(output)) {
    const text = findMessageText(output);
    if (typeof text === "string") return text;
  }

  if ("response" in response) {
    const inner = (response as { response: unknown }).response;
    if (typeof inner === "string") return inner;
  }

  return JSON.stringify(response);
}

/**
 * Adds the failed answer and a note about what was wrong with it, so the next
 * attempt is a different call from the one that just failed.
 *
 * **The defect this fixes was expensive and invisible.** The body used to be
 * built once outside the loop, so every retry was byte-identical to the attempt
 * before it and the model was never told anything had gone wrong. Three attempts
 * meant three full-price calls, three identical wrong answers, and one error
 * message at the end. `max_retries` was a multiplier on cost with no effect on
 * the outcome.
 *
 * Mutates `messages`, which `body` holds by reference — so the next `ai.run`
 * sends the extended conversation without the body needing to be rebuilt.
 *
 * The model's own words go back as an `assistant` turn rather than being quoted
 * inside the correction. That is the shape every chat model is trained on, and
 * it is what makes "your previous reply" refer to something concrete.
 */
function appendCorrection(
  messages: Record<string, unknown>[],
  response: unknown,
  cause: unknown,
  kind: "json" | "schema"
): void {
  messages.push({ role: "assistant", content: excerpt(responseText(response)) });
  messages.push({
    role: "user",
    content:
      kind === "json"
        ? "Your previous reply was not valid JSON. Reply with the JSON object " +
          "alone — no markdown fences, no headings, no commentary before or " +
          "after it. Start your reply with { and end it with }."
        : "Your previous reply was valid JSON but did not match the required " +
          `schema. Fix exactly these problems and reply with the corrected ` +
          `JSON object alone: ${JSON.stringify(cause)}`,
  });
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
    images,
  } = options;

  // `$schema` is metadata about the dialect, not part of the shape, and
  // providers reject unknown keys inside a json_schema format block.
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema);

  const messages: Record<string, unknown>[] = [];
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }
  messages.push({ role: "user", content: buildUserContent(prompt, images) });

  // The first attempt's body, and the only one that is exactly this. Retries
  // append a corrective turn to `messages` — see `correctionFor`.
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

      // Separated from the schema check below because the two failures need
      // different corrections. "That was not JSON at all" and "that was JSON
      // with the wrong fields in it" are not the same note to send back.
      let parsed: unknown;
      try {
        parsed = extractStructuredOutput(response);
      } catch (parseError) {
        lastError = parseError;
        // **Not `"call"`.** The call itself succeeded and the model answered;
        // what failed was the content. Reporting this as a call failure is how
        // a model returning prose gets read as a transport problem, and sends
        // whoever is debugging it to the wrong half of the system entirely.
        lastFailure = "schema";
        appendCorrection(messages, response, parseError, "json");
        continue;
      }

      const result = schema.safeParse(parsed);
      if (result.success) {
        const usage = (response as { usage?: unknown })?.usage;
        return { data: result.data, usage, model };
      }

      lastError = result.error.issues;
      lastFailure = "schema";
      appendCorrection(messages, response, result.error.issues, "schema");
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