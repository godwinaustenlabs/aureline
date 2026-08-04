import { z } from "zod";

/**
 * Helios pattern parameters (v1).
 *
 * Field meanings are defined in CONTEXT.md. Helios generates black-and-white
 * patterns only, so there is deliberately no color field of any kind — color is
 * entirely Iris's responsibility (ADR-0002).
 *
 * `motif_type` and `style` are free-form: CONTEXT.md defines no closed value set
 * for them. Every other field uses CONTEXT.md's canonical values verbatim.
 *
 * This list is a Sprint 1 starting point pending the AI team's validation
 * against real textile-vocabulary test prompts (ticket 04).
 */
export const HeliosParamsSchema = z.object({
  motif_type: z.string().trim().min(1),
  // CONTEXT.md lists this value as `random`/`toss`; `toss` is canonical here.
  repeat_type: z.enum(["block", "half-drop", "brick", "mirror", "toss"]),
  scale: z.enum(["small", "medium", "large"]),
  density: z.enum(["sparse", "balanced", "dense"]),
  line_weight: z.enum(["fine", "medium", "bold"]),
  texture_technique: z.enum([
    "flat",
    "hatching",
    "cross-hatching",
    "stippling",
    "solid-fill",
  ]),
  contrast_level: z.enum(["high", "medium", "low"]),
  style: z.string().trim().min(1),
});

export type HeliosParams = z.infer<typeof HeliosParamsSchema>;

/**
 * Shared by the wire contract and the `helios_runs` audit table.
 *
 * The pipeline is synchronous, so `running` only ever exists as a persisted
 * state mid-invocation — an HTTP response always carries a settled status.
 */
export const HeliosStatusSchema = z.enum(["running", "completed", "failed"]);

export type HeliosStatus = z.infer<typeof HeliosStatusSchema>;

/**
 * `session_id` selects which HeliosAgent Durable Object instance handles the
 * request (ADR-0005). It is not the pipeline invocation's identity — a DO
 * accumulates many invocations, each with its own `p_invoc_id`.
 */
export const HeliosRequestSchema = z.object({
  concept: z.string().trim().min(1).max(1000),
  session_id: z.string().trim().min(1).max(128).optional(),
});

export type HeliosRequest = z.infer<typeof HeliosRequestSchema>;

export interface HeliosResult {
  p_invoc_id: string;
  status: HeliosStatus;
  params: HeliosParams | null;
  image_url: string | null;
  cost_usd: number | null;
  error: string | null;
}
