import type { GarmentRegion, GarmentType } from "@aureline/shared-types";

/**
 * The words Atlas uses to describe a garment to the image model.
 *
 * Atlas has no text model. Nothing interprets the caller's request into richer
 * language, so **whatever is written here is exactly what the model sees**.
 * That makes an incomplete vocabulary a silent failure: a garment type with no
 * description would reach the model as a bare enum value like `kurta`, and the
 * output would be whatever the model happens to associate with that word.
 *
 * This file holds prompt text and nothing else. No model call, no config read,
 * no storage access.
 */

interface GarmentGloss {
	/** How the garment is described to the model. A full noun phrase, not the
	 *  enum value. The model never sees the word "tshirt". */
	description: string;
	/** Which regions actually exist on this garment. Asking for a sleeve on a
	 *  scarf is a request the model cannot satisfy, and it degrades the whole
	 *  output rather than being ignored. */
	validRegions: GarmentRegion[];
}

/**
 * Complete by construction: a garment type with no entry is a **compile
 * error**, not a bad image.
 *
 * **Do not add a fallback, a default, or a `??` anywhere in the lookups.** A
 * fallback is exactly what turns this guarantee back off — it compiles, the
 * tests pass, and a missing entry becomes `undefined` at runtime, which reaches
 * the model as the literal word "undefined" in the prompt.
 *
 * Do not weaken this to `Partial<Record<...>>` or an index signature either,
 * for the same reason.
 */
export const GARMENT_GLOSSARY: Record<GarmentType, GarmentGloss> = {
	tshirt: {
		description:
			"a plain crew-neck short-sleeved cotton t-shirt, laid flat and photographed straight on, with a relaxed straight body and set-in sleeves",
		validRegions: ["front", "back", "neck", "hem", "sleeve"],
	},
	kurta: {
		description:
			"a long straight-cut cotton kurta tunic reaching mid-thigh, laid flat and photographed straight on, with a mandarin collar, a short front placket and long straight sleeves",
		validRegions: ["front", "back", "neck", "hem", "sleeve"],
	},
	scarf: {
		description:
			"a rectangular lightweight woven scarf, laid flat and photographed straight on, with finished edges and no seams, collar or sleeves of any kind",
		// A scarf is a flat rectangle: it has no neck opening and no sleeve.
		validRegions: ["front", "back", "hem"],
	},
	hoodie: {
		description:
			"a pullover hooded sweatshirt in heavyweight fleece, laid flat and photographed straight on, with a lined hood, a kangaroo pocket and ribbed cuffs and waistband",
		validRegions: ["front", "back", "neck", "hem", "sleeve"],
	},
	dress: {
		description:
			"a sleeveless A-line knee-length dress, laid flat and photographed straight on, with a round neckline and a skirt that widens gently from the waist",
		// Sleeveless by construction, so there is no sleeve to place onto.
		validRegions: ["front", "back", "neck", "hem"],
	},
};

interface RegionGloss {
	/** How this area is described to the model, in plain words. */
	description: string;
	/** Sort position, so region order in the prompt is stable no matter what
	 *  order the caller sent them in. */
	order: number;
}

/** Complete by construction, exactly as `GARMENT_GLOSSARY` is. No fallback. */
export const REGION_GLOSSARY: Record<GarmentRegion, RegionGloss> = {
	front: { description: "the front panel of the body", order: 1 },
	back: { description: "the back panel of the body", order: 2 },
	neck: { description: "the collar band and the area immediately around the neckline", order: 3 },
	sleeve: { description: "both sleeves, along their full length", order: 4 },
	hem: { description: "a band along the bottom hem", order: 5 },
};
