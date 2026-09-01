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
