import Ajv, { type Schema } from "ajv";
import {
  buildAiRunOptions,
  type AiRunOptions,
  type GatewayConfig,
} from "./aiGateway";

const ajv = new Ajv();

/**
 * Options to control retry behavior when the model's output
 * fails schema validation.
 */
export interface GetTextualModelOutputOptions {
  /** Maximum number of attempts before giving up (default: 3) */
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
 * Calls a model with a prompt and returns output validated against
 * the given JSON schema. Retries on schema drift (invalid output).
 * Throws an error if all retries are exhausted without valid output,
 * so the pipeline can catch it upstream.
 */
export async function getTextualModelOutput<T = unknown>(
  schema: Schema,
  prompt: string,
  model: string,
  ai: AiRunner,
  options: GetTextualModelOutputOptions = {}
): Promise<T> {
  const { maxRetries = 3, gateway } = options;
  const validate = ajv.compile(schema);

  // Built once, outside the loop: every attempt is the same call routed the
  // same way, so the gateway sees one consistent request shape.
  const runOptions = buildAiRunOptions(gateway);

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await ai.run(model, { prompt }, runOptions);

      const parsed: unknown =
        typeof response === "string" ? JSON.parse(response) : response;

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
      `Last error: ${JSON.stringify(lastError)}`
  );
}