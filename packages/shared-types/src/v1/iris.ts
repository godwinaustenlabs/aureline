import { z } from "zod";

/**
 * The controlled color vocabulary (v1).
 *
 * iris-04 owns the final list and the hex value behind each name; these 30 are
 * the starting proposal from the Iris sprint plan. A fixed enum rather than free
 * text because nothing downstream can map "emerald", "emerald green" and "dark
 * jewel green" onto one hex value.
 */
export const ColorNameSchema = z.enum([
  "ivory", "cream", "sand", "taupe", "stone", "charcoal", "black", "white",
  "crimson", "rust", "terracotta", "coral", "blush", "rose",
  "amber", "gold", "mustard", "ochre",
  "olive", "sage", "emerald", "forest_green", "mint",
  "teal", "turquoise", "cobalt", "navy", "indigo",
  "plum", "burgundy",
]);

export type ColorName = z.infer<typeof ColorNameSchema>;

/**
 * What the planner call returns, and what the image call is built from.
 *
 * Saved verbatim on the audit row as `planner_params`, so a run can be replayed
 * from disk without calling the planner again.
 *
 * `primary_color` is required and the other two are not: a single-color scheme
 * is a legitimate answer, an empty one is not. `mood` is free text because it
 * carries the part of the concept no enum can hold.
 */
export const IrisParamsSchema = z.object({
  primary_color: ColorNameSchema,
  secondary_color: ColorNameSchema.optional(),
  accent_color: ColorNameSchema.optional(),
  harmony: z.enum(["monochrome", "analogous", "complementary", "triadic", "neutral"]),
  saturation: z.enum(["muted", "balanced", "vibrant"]),
  background_treatment: z.enum(["solid", "gradient", "textured", "transparent"]),
  mood: z.string().trim().min(1),
});

export type IrisParams = z.infer<typeof IrisParamsSchema>;

/**
 * Shared by the wire contract and the `iris_runs` audit table, exactly as
 * `HeliosStatusSchema` is.
 *
 * The pipeline is synchronous, so `running` only ever exists as a persisted
 * state mid-invocation. An HTTP response always carries a settled status.
 */
export const IrisStatusSchema = z.enum(["running", "completed", "failed"]);

export type IrisStatus = z.infer<typeof IrisStatusSchema>;

/**
 * What a caller sends Iris.
 *
 * `concept` is the same free text sent to Helios, not a color-only fragment.
 * There is no coordinator engine yet, so the caller sends it to both.
 *
 * `motif_ref` is a reference to the pattern Iris colors: an R2 key or a URL,
 * never raw image bytes. Bytes in a JSON body means base64 through every layer,
 * a much larger request, and no way to look at the input afterwards. Helios
 * returns a servable URL for the same reason.
 *
 * `source_p_invoc_id` is the Helios run that produced `motif_ref`. It is carried
 * forward onto every `iris_runs` row so a full-pipeline view is possible before
 * the per-engine databases are merged. See
 * .scratch/shared-sprint-2/sprint-2-3-conventions.md.
 *
 * `session_id` means what it means for Helios: it selects which Durable Object
 * instance handles the request (ADR-0005), not the invocation's identity.
 */
export const IrisRequestSchema = z.object({
  concept: z.string().trim().min(1).max(1000),
  motif_ref: z.string().trim().min(1).max(512),
  source_p_invoc_id: z.string().trim().min(1).max(128),
  session_id: z.string().trim().min(1).max(128).optional(),
});

export type IrisRequest = z.infer<typeof IrisRequestSchema>;

/**
 * A request to run the image half of an existing invocation again, using the
 * params already on disk instead of calling the planner.
 *
 * Same shape and same meaning as `HeliosResumeRequestSchema`: `p_invoc_id` names
 * the run to resume, `session_id` picks the Durable Object, and the resumed run
 * gets its own new `p_invoc_id` rather than reusing this one.
 */
export const IrisResumeRequestSchema = z.object({
  p_invoc_id: z.string().trim().min(1).max(128),
  session_id: z.string().trim().min(1).max(128).optional(),
});

export type IrisResumeRequest = z.infer<typeof IrisResumeRequestSchema>;

/**
 * What Iris returns, and therefore what Atlas consumes.
 *
 * A schema rather than an interface (unlike `HeliosResult`) because Atlas
 * receives this across a worker boundary and has to validate it at runtime,
 * which an interface cannot do. This difference from Helios is deliberate.
 *
 * Every field past `status` is nullable because a failed run has no image, no
 * params and no cost, and it still has to be representable here.
 *
 * `width` and `height` are here so Atlas knows what it is placing without
 * having to fetch and decode the image first.
 */
export const IrisResultSchema = z.object({
  p_invoc_id: z.string(),
  source_p_invoc_id: z.string(),
  status: IrisStatusSchema,
  params: IrisParamsSchema.nullable(),
  image_url: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  cost_usd: z.number().nullable(),
  error: z.string().nullable(),
});

export type IrisResult = z.infer<typeof IrisResultSchema>;
