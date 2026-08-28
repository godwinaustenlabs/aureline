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
 * What a caller sends Helios.
 *
 * `design_session_id` identifies **the design**, not this call. It is minted
 * once upstream and carried unchanged through every engine, so Helios's pattern,
 * Iris's colouring of it and Atlas's placement of that all answer to one id. It
 * is carried onto every `helios_runs` row, which is what makes a full-pipeline
 * view possible before the per-engine databases are merged. See AGENTS.md §3
 * and ADR-HELIOS-0001.
 *
 * **Required, with no fallback.** Helios will not mint one and will not accept
 * the old `p_invoc_id` name: a request without it is rejected with a 400. A run
 * that cannot be traced back to a design is worse than a run that did not
 * happen, because it still spends money and still lands in the audit table.
 *
 * `session_id` selects which HeliosAgent Durable Object instance handles the
 * request (ADR-0005). It is not the pipeline invocation's identity — a DO
 * accumulates many invocations, each with its own `pipeline_id` — and it is not
 * the design's identity either.
 */
export const HeliosRequestSchema = z.object({
  concept: z.string().trim().min(1).max(1000),
  design_session_id: z.string().trim().min(1).max(128),
  session_id: z.string().trim().min(1).max(128).optional(),
});

export type HeliosRequest = z.infer<typeof HeliosRequestSchema>;

/**
 * A request to run the image half of an existing invocation again, using the
 * params already on disk instead of calling the planner.
 *
 * `pipeline_id` names the run to resume. `session_id` is optional and works
 * exactly as it does on `HeliosRequestSchema`: it picks the Durable Object, and
 * a request without one lands on the same shared instance a generate without
 * one did, so anything that can be generated can be resumed.
 *
 * The resumed run gets its own **new** `pipeline_id`; this one is never reused.
 * That is exactly what a pipeline id is for, and it is how "which attempt is the
 * latest" stays answerable. Its `design_session_id` is copied from the run being
 * resumed, so the retry stays part of the same design and is not sent again here.
 */
export const HeliosResumeRequestSchema = z.object({
  pipeline_id: z.string().trim().min(1).max(128),
  session_id: z.string().trim().min(1).max(128).optional(),
});

export type HeliosResumeRequest = z.infer<typeof HeliosResumeRequestSchema>;

export interface HeliosResult {
  /** This run of Helios. A re-run of the same design gets a different one. */
  pipeline_id: string;
  /** The design every engine's run of it shares. Iris and Atlas carry it forward. */
  design_session_id: string;
  status: HeliosStatus;
  params: HeliosParams | null;
  image_url: string | null;
  cost_usd: number | null;
  error: string | null;
}
