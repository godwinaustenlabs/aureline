import { z } from "zod";

/**
 * Contracts every engine shares, rather than each defining its own.
 *
 * The point of the file is that nothing downstream has to ask which engine
 * produced a value. `image_prompt` means the same thing and obeys the same
 * validation on Helios, Iris and whatever comes next, so a consumer reading a
 * params object finds it in one place with one shape.
 */

/**
 * The planner's own free-form instruction to the image model.
 *
 * This is the second of the two prompt layers described in
 * `docs/Project Wide/phase-1-plan.md` §6. The first is the deterministic
 * template each engine already owns (`buildColorPrompt`, `buildImagePrompt`),
 * which turns structured fields into words in an order we control. This layer
 * is where anything that template could not anticipate goes — something noticed
 * in a reference image today, something retrieved by RAG once Phase 2 lands.
 *
 * **Written for the image model, not for the user.** It is appended after the
 * deterministic clauses, never in place of them, and it only ever adds to the
 * positive prompt: it must not be able to weaken Helios's exclusion list or its
 * monochrome lock, which are ADR-0002 promises and are not model-writable.
 *
 * **Required on every engine from the start**, before RAG exists to make it
 * smarter. Without RAG the planner writes something fairly generic, which is
 * fine — the mechanism has to work end to end now so that turning RAG on later
 * is a content change and not a code change.
 *
 * The 500-character cap is load-bearing, not tidiness. Helios refuses a composed
 * prompt over Flux's 2048-character limit *before* the billed call
 * (`imageGenerator.ts`), and that guard exists for bugs. An uncapped
 * model-written field would make it reachable in ordinary operation, turning a
 * safety net into a routine failure. Capping the one free-form input is cheaper
 * than raising the net.
 */
export const ImagePromptSchema = z.string().trim().min(1).max(500);

export type ImagePrompt = z.infer<typeof ImagePromptSchema>;

/**
 * A reference image a user attached to their request.
 *
 * **Held in memory for one invocation and never persisted.** It is not written
 * to R2, not stored on a run row, and not recoverable afterwards. Persisting it
 * would need a key convention, a retention rule and a pruning path, which is
 * scope Phase 1 does not have — see ADR-SHARED-0003, which also records why
 * `POST /resume` needs neither.
 *
 * `contentType` is carried rather than sniffed from the bytes. The planner call
 * builds a `data:` URL from it, and this repo has no image decoder to guess with
 * — a wrong guess here is a model call that fails for a reason the error will
 * not name. It comes off the uploaded `File`, which the browser fills in.
 *
 * Deliberately not a `File`: a `File` is a transport detail of
 * `multipart/form-data`, and by the time this reaches a planner the transport is
 * nobody's business (phase-1-plan §2 step 2 — "the raw bytes, not a `File`
 * object").
 */
export const ReferenceImageSchema = z.object({
  /**
   * Narrowed to `Uint8Array<ArrayBuffer>` rather than left as a bare
   * `Uint8Array`, because that is the type the image helpers require: a `Blob`
   * part must be backed by an `ArrayBuffer`, and a bare `Uint8Array` also admits
   * a `SharedArrayBuffer` that cannot be one (see `InputImage` in
   * shared-utils/getImageToImageOutput.ts).
   *
   * `z.custom` with a real predicate rather than `z.instanceof`, because
   * `z.instanceof(Uint8Array)` infers the wider `ArrayBufferLike` form and the
   * gap would then have to be bridged at the call site with a cast — which
   * AGENTS.md §4 rightly forbids. This is a runtime-checked narrowing, not a
   * check switched off: every source that builds one of these is a
   * `new Uint8Array(await file.arrayBuffer())`, which is exactly this type.
   */
  bytes: z.custom<Uint8Array<ArrayBuffer>>((value) => value instanceof Uint8Array, {
    message: "expected image bytes as a Uint8Array",
  }),
  contentType: z.string().trim().min(1),
});

export type ReferenceImage = z.infer<typeof ReferenceImageSchema>;

/**
 * What kind of thing a design is: a repeating tile, or a single motif.
 *
 * Shared rather than owned by Helios, even though Helios is the only engine
 * that classifies. The classifier decides once, at the top of the pipeline, and
 * every engine downstream reads that decision — so the vocabulary has to mean
 * the same thing in all of them or the decision does not survive the hop
 * (`phase-2-plan.md` §6.1).
 *
 * **`tile`** is a seamless repeating unit. Its edges are continuous, so it
 * shows no seam when laid next to a copy of itself.
 *
 * **`motif`** is a single design element placed on one part of a garment. It
 * does not repeat and it is not required to tile.
 *
 * Two values, not three. "Either" is not a mode — an ambiguous brief is
 * resolved to `tile` by the classifier prompt rather than carried forward as
 * an undecided state that every consumer would then have to handle.
 */
export const DesignModeSchema = z.enum(["tile", "motif"]);

export type DesignMode = z.infer<typeof DesignModeSchema>;

/**
 * The classifier's answer: what kind of design this is, and where it goes.
 *
 * **Stored in its own column, never merged into a params object.** This is
 * infrastructure — the classifier's reading of the brief — and not a creative
 * output of the planner. Keeping it separate is what lets `HeliosParamsSchema`
 * and `IrisParamsSchema` stay exactly as they are, with no planner-output
 * variant and no merge step at validate (`phase-2-plan.md` §6.2).
 */
export const ClassificationSchema = z.object({
  mode: DesignModeSchema,
  /**
   * Which part of the garment this run is for — `neckline`, `cuff`, `yoke`.
   *
   * **Optional, and absent rather than empty when there is none.** A tile never
   * has one. A motif usually does, but "a single peacock motif" names no part
   * and must not be forced to invent one: a fabricated `garment_part` reaches
   * the image prompt as a real instruction and tailors the design to a part the
   * user never asked for.
   *
   * Trimmed and capped at 64 characters because it is model-written and lands
   * in a prompt. The floor of 1 is what stops `""` from being stored as a
   * present-but-meaningless value, which would read downstream as "there is a
   * part" while naming none.
   */
  garment_part: z.string().trim().min(1).max(64).optional(),
});

export type Classification = z.infer<typeof ClassificationSchema>;

/**
 * How much the research stage actually retrieved.
 *
 * Three outcomes that a single boolean would flatten, and the distinction is
 * the point of recording it at all:
 *
 * - **`none`** — the model called no search tool. A legitimate answer, not a
 *   failure: it decided it had enough. Nothing was retrieved because nothing
 *   was asked for.
 * - **`thin`** — it searched and the knowledge base had little to say. The run
 *   completes and the planner is grounded on less than we would like.
 * - **`ok`** — enough text came back to be worth putting in front of the
 *   planner.
 *
 * A retrieval *error* is not on this scale. That stops the run (§13) rather
 * than being recorded as a quality, because "the knowledge base is empty" and
 * "the knowledge base is unreachable" want different answers.
 */
export const SearchQualitySchema = z.enum(["none", "thin", "ok"]);

export type SearchQuality = z.infer<typeof SearchQualitySchema>;
