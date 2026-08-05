import Ajv, { type Schema } from "ajv";

const ajv = new Ajv();

/**
 * Options to control retry behavior when the model's output
 * fails schema validation.
 */
export interface GetTextualModelOutputOptions {
  /** Maximum number of attempts before giving up (default: 3) */
  maxRetries?: number;
}

/**
 * Minimal interface for the model-calling client this helper needs.
 * In Cloudflare Workers, this is typically `env.AI`.
 */
export interface AiRunner {
  run: (model: string, input: Record<string, unknown>) => Promise<unknown>;
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
  const { maxRetries = 3 } = options;
  const validate = ajv.compile(schema);

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await ai.run(model, { prompt });

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