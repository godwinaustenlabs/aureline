import type { AtlasPlacement, Coverage, GarmentRegion, GarmentType, PatternScale } from "@aureline/shared-types";
import { GARMENT_GLOSSARY, REGION_GLOSSARY } from "./garment.glossary";

/**
 * Turns an `AtlasPlacement` into the string the image model is given.
 *
 * Atlas has no text model, so this function is the entire creative surface of
 * the engine. It is a deterministic translator with no design judgement in it.
 */

/**
 * Bump this whenever the wording below changes, in the same commit as the
 * wording.
 *
 * It travels into `AtlasPlacement.prompt_version` and therefore onto
 * `garment_regions` on every row. When output quality changes, the first
 * question is what the prompt was, and this is the only place that answer
 * survives.
 */
export const PLACEMENT_PROMPT_VERSION = "atlas-placement-v1";

/** How each coverage style is described. Never the bare enum value. */
const COVERAGE_PHRASES: Record<Coverage, string> = {
	allover: "repeating continuously across the whole of",
	panel: "as a single large panel filling",
	trim: "as a narrow decorative border along the edge of",
};

/** How each pattern scale is described. Never the bare enum value. */
const SCALE_PHRASES: Record<PatternScale, string> = {
	small: "The motifs should be small and finely repeated, many across the width of the garment.",
	medium: "The motifs should be at a moderate scale, clearly readable at arm's length.",
	large: "The motifs should be large and bold, only a few spanning the width of the garment.",
};

/**
 * Which of the requested regions this garment actually has.
 *
 * The pipeline calls this **before anything bills**, so an impossible request
 * is refused rather than half-satisfied by a paid call. A sleeve on a scarf is
 * not something the model can satisfy, and asking anyway degrades the whole
 * output rather than being quietly ignored.
 */
export function validRegionsFor(
	garment: GarmentType,
	requested: GarmentRegion[],
): { valid: GarmentRegion[]; rejected: GarmentRegion[] } {
	const available = GARMENT_GLOSSARY[garment].validRegions;

	return {
		valid: requested.filter((region) => available.includes(region)),
		rejected: requested.filter((region) => !available.includes(region)),
	};
}

/**
 * Builds the placement instruction.
 *
 * **Deterministic.** Same placement in, same string out, every time. No
 * randomness, no branching on anything outside the `AtlasPlacement` it is
 * given, no reading config or env. That is what makes a bad output
 * attributable: if two runs with the same placement produce different images,
 * that is the model, not us.
 *
 * Regions are sorted by their glossary `order` rather than by the order they
 * arrived in, so `["hem","back"]` and `["back","hem"]` produce one identical
 * string. Otherwise two identical requests produce two different prompts, two
 * different gateway cache keys, and an apparent model inconsistency that is
 * actually ours.
 */
export function buildPlacementPrompt(placement: AtlasPlacement): string {
	const garment = GARMENT_GLOSSARY[placement.garment_type];

	const regions = [...placement.regions]
		.sort((a, b) => REGION_GLOSSARY[a].order - REGION_GLOSSARY[b].order)
		.map((region) => REGION_GLOSSARY[region].description);

	// The model is given two images and has no way to know which is which from
	// the bytes alone. atlas-07 always sends the pattern as input_image_0 and the
	// garment as input_image_1, and these two sentences are what tie the prompt
	// to that order. Without them the model may redraw the pattern, invent a
	// different garment, or blend the two.
	const inputs = [
		"You are given two images.",
		"The FIRST image is a flat repeating textile pattern. It is the pattern to apply — do not redraw it, do not restyle it, and do not treat it as a garment.",
		"The SECOND image is the actual garment to print onto. Render that same garment, keeping its shape, cut, colour and fabric texture — do not substitute a different or similar-looking one.",
	].join(" ");

	const subject = `The garment in the second image is ${garment.description}.`;

	const instruction = `Print the pattern from the first image onto that garment, ${COVERAGE_PHRASES[placement.coverage]} ${listPhrase(regions)}.`;

	const scale = SCALE_PHRASES[placement.pattern_scale];

	const fidelity =
		"Keep the pattern's motifs, spacing and colours exactly as they appear in the first image. The pattern must follow the drape and folds of the garment rather than sitting flat on top of it. Leave every other part of the garment unpatterned.";

	return [inputs, subject, instruction, scale, fidelity].join(" ");
}

/** "a, b and c" — so the region list reads as a sentence rather than an array. */
function listPhrase(items: string[]): string {
	if (items.length === 0) return "the garment";
	if (items.length === 1) return items[0]!;
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
