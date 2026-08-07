import { HeliosParamsSchema } from "@aureline/shared-types";
import { getTextualModelOutput, type TextualModelOutput } from "@aureline/shared-utils";
import type { z } from "zod";

/**
 * Thin call site for the planner's structured-output request.
 * Owns nothing about the schema itself — HeliosParamsSchema is the contract,
 * defined once in @aureline/shared-types.
 */
export async function callPlannerModel(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  ai: Parameters<typeof getTextualModelOutput>[3],
  options: Parameters<typeof getTextualModelOutput>[4]
): Promise<TextualModelOutput<z.infer<typeof HeliosParamsSchema>>> {
  return getTextualModelOutput(HeliosParamsSchema, userPrompt, model, ai, {
    ...options,
    instructions: systemPrompt,
  });
}