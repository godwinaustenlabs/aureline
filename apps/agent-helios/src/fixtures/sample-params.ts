import type { HeliosParams } from "@aureline/shared-types";

/**
 * Valid `HeliosParams` fixtures for the test suites.
 *
 * Both are annotated with the real `HeliosParams` rather than left to infer.
 * That annotation is the point: if the contract gains a field or tightens an
 * enum, these stop compiling, which is exactly what a suite full of `as never`
 * had stopped doing (AGENTS.md §4).
 *
 * Four near-identical copies of this object used to live inline across
 * `do.repository.test.ts`, `resume.test.ts`, `pipeline.test.ts` and
 * `imageGenerator.test.ts`, two of them byte-for-byte the same.
 */

/** The everyday valid shape, used wherever a test just needs real params. */
export const sampleParamsFull: HeliosParams = {
	motif_type: "art deco fan",
	repeat_type: "half-drop",
	scale: "medium",
	density: "balanced",
	line_weight: "medium",
	texture_technique: "hatching",
	contrast_level: "high",
	style: "traditional",
};

/**
 * A second valid shape that shares no enum member with `sampleParamsFull`.
 *
 * `HeliosParams` has no optional fields, so unlike Iris's minimal fixture this
 * cannot be a smaller object. It earns its place a different way: a test that
 * passes with both is not quietly depending on one particular set of members.
 */
export const sampleParamsAlternate: HeliosParams = {
	motif_type: "art deco paisley",
	repeat_type: "brick",
	scale: "large",
	density: "sparse",
	line_weight: "fine",
	texture_technique: "stippling",
	contrast_level: "low",
	style: "modern",
};

/** base64 for the bytes [72, 101, 108, 108, 111] ("Hello"). Not a real image:
 * nothing in Helios decodes it, the image model's reply is passed to R2 as-is. */
export const SAMPLE_IMAGE_BASE64 = "SGVsbG8=";

/**
 * The design a test run belongs to.
 *
 * Shared so that every suite asserting the id travels from request to row to
 * result is asserting on the *same* value. Two suites with two literals can
 * both pass while the id they each check is one they wrote themselves a line
 * earlier, which is not the thing worth checking.
 */
export const SAMPLE_DESIGN_SESSION_ID = "design-7f3a";
