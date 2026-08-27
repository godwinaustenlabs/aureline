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
};

/** Exercises the minimum valid shape: only `primary_color` is required. */
export const sampleParamsMinimal: IrisParams = {
	primary_color: "black",
	harmony: "monochrome",
	saturation: "muted",
	background_treatment: "transparent",
	mood: "minimal and graphic",
};
