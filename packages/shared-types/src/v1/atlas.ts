import { z } from "zod";
import { IrisResultSchema } from "./iris";

/**
 * Atlas — the Repeat Engine (v1), read as garment placement this sprint.
 *
 * Atlas takes Iris's colored pattern and places it across garment regions,
 * producing the final piece shown on clothing. It has **one billable image
 * call and no text call**, which is why its audit table has one row per
 * invocation rather than two (ADR-ATLAS-0001).
 *
 * Atlas's input is Iris's output. `IrisResultSchema` is imported below rather
 * than restated, so the connection is enforced by the compiler instead of by
 * everyone remembering it. A hand-maintained duplicate compiles on both sides
 * and fails at runtime on the first real call.
 *
 * **The two ids are different things and the names say which (AGENTS.md §3):**
 * `pipeline_id` is one run of Atlas, `design_session_id` is the design that
 * Helios, Iris and Atlas all worked on. `session_id` is neither — it only picks
 * a Durable Object.
 */

/**
 * The garment areas a pattern can be placed on.
 *
 * A fixed list rather than free text because there is no text model in Atlas
 * to interpret "around the collar bit". atlas-05 owns the description behind
 * each name; the list itself is settled here so the playground and the prompt
 * builder read the same one.
 */
export const GarmentRegionSchema = z.enum(["back", "front", "neck", "hem", "sleeve"]);

export type GarmentRegion = z.infer<typeof GarmentRegionSchema>;

/**
 * The garment the pattern is placed on.
 *
 * The caller also sends a real photo of it as `garment_ref`, but the model
 * still needs the type named in words so the prompt can describe cut and fit
 * precisely. Both together, not one replacing the other.
 */
export const GarmentTypeSchema = z.enum(["tshirt", "kurta", "scarf", "hoodie", "dress"]);

export type GarmentType = z.infer<typeof GarmentTypeSchema>;

/** How much of the garment the pattern covers. */
export const CoverageSchema = z.enum(["allover", "panel", "trim"]);

export type Coverage = z.infer<typeof CoverageSchema>;

/** How large the pattern's motifs read on the finished garment. */
export const PatternScaleSchema = z.enum(["small", "medium", "large"]);

export type PatternScale = z.infer<typeof PatternScaleSchema>;

/**
 * What this run placed, and how. Recorded on the audit row as
 * `garment_regions`.
 *
 * Named "placement" rather than "params" because no planner model produced it:
 * it is the caller's request plus whatever atlas-05's prompt builder resolved.
 * In Helios and Iris, "params" means what the planner decided, and Atlas has no
 * planner — a different job gets a different name, so nobody goes looking for
 * the model that produced it.
 *
 * `prompt_version` travels onto every row so that when output quality changes,
 * the first question — what was the prompt — has an answer that survives.
 */
export const AtlasPlacementSchema = z.object({
  garment_type: GarmentTypeSchema,
  regions: z.array(GarmentRegionSchema).min(1).max(5),
  coverage: CoverageSchema,
  pattern_scale: PatternScaleSchema,
  prompt_version: z.string().trim().min(1),
});

export type AtlasPlacement = z.infer<typeof AtlasPlacementSchema>;

/** Shared by the wire contract and the `atlas_runs` audit table. */
export const AtlasStatusSchema = z.enum(["running", "completed", "failed"]);

export type AtlasStatus = z.infer<typeof AtlasStatusSchema>;

/**
 * What a caller sends Atlas.
 *
 * `pattern_ref` is Iris's `image_url` or R2 key — a reference and never bytes,
 * for the same reason `motif_ref` is on `IrisRequestSchema`.
 *
 * `garment_ref` is a URL to the caller-supplied photo of the actual garment the
 * pattern gets printed on. There is no upload endpoint in this sprint, so
 * unlike `pattern_ref` this is never an R2 key, only a URL Atlas fetches
 * itself — which is why it is validated with `.url()` and `pattern_ref`
 * deliberately is not. If an upload endpoint arrives later, this stays a
 * reference either way and only the set of valid shapes widens.
 *
 * `design_session_id` identifies **the design**, not this call. It is minted
 * once upstream and carried unchanged through Helios and Iris before it reaches
 * here, and Atlas passes it on untouched. It is what stitches all three
 * engines' work into one story, and what makes a full-pipeline view possible
 * before the per-engine databases are merged. **Required, with no fallback, and
 * Atlas never mints one:** a run that cannot be traced back to a design is
 * worse than a run that did not happen, because it still spends money and still
 * lands in the audit table. See AGENTS.md §3.
 *
 * **There is deliberately no free-text field.** Not `concept`, not `notes`, not
 * `style`. Atlas has no text model, so anything free-form would go straight
 * into an image prompt — an unbounded input to a billed call that nothing can
 * validate. Everything the caller can ask for is a fixed enum. Widening an enum
 * later is a small change; removing a free-text field after the playground
 * sends it is not.
 *
 * `session_id` picks the Durable Object instance (ADR-0005) — not the
 * invocation's identity, and not the design's.
 */
export const AtlasRequestSchema = z.object({
  pattern_ref: z.string().trim().min(1).max(512),
  garment_ref: z.string().trim().url().max(512),
  design_session_id: z.string().trim().min(1).max(128),
  garment_type: GarmentTypeSchema,
  regions: z.array(GarmentRegionSchema).min(1).max(5),
  coverage: CoverageSchema.default("allover"),
  pattern_scale: PatternScaleSchema.default("medium"),
  session_id: z.string().trim().min(1).max(128).optional(),
});

export type AtlasRequest = z.infer<typeof AtlasRequestSchema>;

/**
 * A request to run an existing invocation's image call again, using the
 * placement already on disk.
 *
 * `pipeline_id` names the run to resume and `session_id` picks the Durable
 * Object. The resumed run gets its own **new** `pipeline_id` rather than
 * reusing this one — that is exactly what a pipeline id is for, and it is how
 * "which attempt is the latest" stays answerable. Its `design_session_id` is
 * copied from the run being resumed, so the retry stays part of the same design
 * and is not sent again here.
 */
export const AtlasResumeRequestSchema = z.object({
  pipeline_id: z.string().trim().min(1).max(128),
  session_id: z.string().trim().min(1).max(128).optional(),
});

export type AtlasResumeRequest = z.infer<typeof AtlasResumeRequestSchema>;

/**
 * What Atlas returns.
 *
 * A schema rather than an interface, matching `IrisResultSchema` and
 * deliberately unlike `HeliosResult`, because Athena will eventually read this
 * across a worker boundary and will need to validate it at runtime.
 *
 * `placement` is kept on a failure whenever validation already produced one,
 * for the same reason Iris keeps `params`: partial state is more useful than
 * none, and it is what makes the run resumable.
 */
export const AtlasResultSchema = z.object({
  /** This run of Atlas. A re-run of the same design gets a different one. */
  pipeline_id: z.string(),
  /** The design every engine's run of it shares, carried forward untouched. */
  design_session_id: z.string(),
  status: AtlasStatusSchema,
  placement: AtlasPlacementSchema.nullable(),
  image_url: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  cost_usd: z.number().nullable(),
  error: z.string().nullable(),
});

export type AtlasResult = z.infer<typeof AtlasResultSchema>;

/**
 * Atlas's input is Iris's output.
 *
 * This helper exists so that the connection is enforced by the compiler rather
 * than by everyone remembering it, and so there is exactly one path from an
 * Iris result into an Atlas request. Nothing should reconstruct these two
 * fields by hand. shared-02 swaps sample data for real data, and this is the
 * function it goes through.
 *
 * Note what it carries across: Iris's `image_url` becomes Atlas's
 * `pattern_ref`, and the `design_session_id` passes through **unchanged**.
 * Iris's `pipeline_id` is deliberately not carried — that names Iris's run, not
 * the design, and Atlas mints its own.
 *
 * **Throws on a failed Iris run.** A run with a null `image_url` produced no
 * pattern, and there is nothing for Atlas to place — a request built from one
 * would reach a billed call with a reference to nothing. Failing here, loudly,
 * is the point.
 */
export function atlasInputFromIrisResult(
  result: z.infer<typeof IrisResultSchema>
): Pick<AtlasRequest, "pattern_ref" | "design_session_id"> {
  if (!result.image_url) {
    throw new Error(
      `atlasInputFromIrisResult: iris run ${result.pipeline_id} has no image_url (status: ${result.status}) — there is nothing to place.`
    );
  }

  if (!result.design_session_id) {
    throw new Error(
      "atlasInputFromIrisResult: iris result has no design_session_id — the chain back to the design is broken."
    );
  }

  return {
    pattern_ref: result.image_url,
    design_session_id: result.design_session_id,
  };
}
