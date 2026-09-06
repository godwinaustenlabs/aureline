import type { IrisParams } from "@aureline/shared-types";

/**
 * Valid `IrisParams` fixtures for the fake planner (iris-05) and for tests.
 *
 * Colour names are picked from the safe middle of `ColorNameSchema`, not its
 * edges: iris-04 owns the final list and a borderline name like `ochre` or
 * `taupe` could still be dropped from it. `navy`, `gold`, `ivory` and `black`
 * are not going anywhere.
 */

/** Exercises all three optional colour fields. */
export const sampleParamsFull: IrisParams = {
	primary_color: "navy",
	secondary_color: "gold",
	accent_color: "ivory",
	harmony: "complementary",
	saturation: "balanced",
	background_treatment: "solid",
	mood: "regal and refined, evoking antique brocade",
	image_prompt:
		"Let the gold sit only in the finest details so the navy stays dominant across the ground.",
};

/**
 * Exercises the minimum valid shape: only the three colour fields are optional.
 *
 * `image_prompt` is present here despite the name, because it is required on
 * every engine from the start — a "minimal" params object without one is not a
 * valid params object.
 */
export const sampleParamsMinimal: IrisParams = {
	primary_color: "black",
	harmony: "monochrome",
	saturation: "muted",
	background_treatment: "transparent",
	mood: "minimal and graphic",
	image_prompt: "Keep the black flat and even, with no gradient in the ground.",
};
