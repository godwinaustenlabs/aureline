import { describe, it, expect } from "vitest";
import {
	GarmentRegionSchema,
	GarmentTypeSchema,
	type AtlasPlacement,
	type GarmentType,
} from "@aureline/shared-types";
import { buildPlacementPrompt, validRegionsFor, PLACEMENT_PROMPT_VERSION } from "./placement.prompt";
import { GARMENT_GLOSSARY, REGION_GLOSSARY } from "./garment.glossary";

function placement(overrides: Partial<AtlasPlacement> = {}): AtlasPlacement {
	return {
		garment_type: "tshirt",
		regions: ["back", "hem"],
		coverage: "allover",
		pattern_scale: "medium",
		prompt_version: PLACEMENT_PROMPT_VERSION,
		...overrides,
	};
}

describe("the glossary is complete", () => {
	it("describes every garment type in the contract", () => {
		// The compile-time guarantee is Record<GarmentType, …>; this is the
		// runtime half, which also catches an enum widened without the glossary.
		expect(Object.keys(GARMENT_GLOSSARY).sort()).toEqual([...GarmentTypeSchema.options].sort());
	});

	it("describes every region in the contract", () => {
		expect(Object.keys(REGION_GLOSSARY).sort()).toEqual([...GarmentRegionSchema.options].sort());
	});

	it("describes each garment as a full noun phrase, never as its enum value", () => {
		// The silent failure this glossary exists to prevent is a bare enum value
		// standing in for a description. It is entirely fine for a description to
		// contain the word — "a rectangular lightweight woven scarf" should say
		// scarf — so what is checked is that it says considerably more than that.
		for (const [name, gloss] of Object.entries(GARMENT_GLOSSARY)) {
			expect(gloss.description).not.toBe(name);
			expect(gloss.description.length).toBeGreaterThan(60);
			// A real noun phrase names the cut or the fit, not just the thing.
			expect(gloss.description).toMatch(/,/);
		}
	});

	it("gives every garment at least one valid region, and none it lacks", () => {
		for (const gloss of Object.values(GARMENT_GLOSSARY)) {
			expect(gloss.validRegions.length).toBeGreaterThan(0);
			expect(new Set(gloss.validRegions).size).toBe(gloss.validRegions.length);
		}
		// Filled in honestly rather than copied: a scarf is a flat rectangle and
		// the dress is sleeveless, so neither has everything.
		expect(GARMENT_GLOSSARY.scarf.validRegions).not.toContain("sleeve");
		expect(GARMENT_GLOSSARY.scarf.validRegions).not.toContain("neck");
		expect(GARMENT_GLOSSARY.dress.validRegions).not.toContain("sleeve");
	});

	it("gives every region a distinct sort position", () => {
		const orders = Object.values(REGION_GLOSSARY).map((r) => r.order);
		expect(new Set(orders).size).toBe(orders.length);
	});
});

describe("buildPlacementPrompt is deterministic", () => {
	it("returns a byte-identical string for the same placement twice", () => {
		expect(buildPlacementPrompt(placement())).toBe(buildPlacementPrompt(placement()));
	});

	it("ignores the order regions arrived in", () => {
		// Two identical requests must not produce two prompts, two gateway cache
		// keys, and an apparent model inconsistency that is actually ours.
		const a = buildPlacementPrompt(placement({ regions: ["hem", "back"] }));
		const b = buildPlacementPrompt(placement({ regions: ["back", "hem"] }));
		expect(a).toBe(b);
	});

	it("orders regions by the glossary, not alphabetically or by arrival", () => {
		const prompt = buildPlacementPrompt(placement({ regions: ["hem", "neck", "front"] }));
		const front = prompt.indexOf(REGION_GLOSSARY.front.description);
		const neck = prompt.indexOf(REGION_GLOSSARY.neck.description);
		const hem = prompt.indexOf(REGION_GLOSSARY.hem.description);
		expect(front).toBeLessThan(neck);
		expect(neck).toBeLessThan(hem);
	});
});

describe("buildPlacementPrompt says what the model needs to know", () => {
	it("names each garment type in full", () => {
		for (const garment of GarmentTypeSchema.options) {
			const prompt = buildPlacementPrompt(placement({
				garment_type: garment,
				regions: [GARMENT_GLOSSARY[garment as GarmentType].validRegions[0]!],
			}));
			expect(prompt).toContain(GARMENT_GLOSSARY[garment as GarmentType].description);
		}
	});

	it("tells the model which input image is which", () => {
		// atlas-07 always sends the pattern as input_image_0 and the garment as
		// input_image_1. Without these two sentences the model may redraw the
		// pattern, invent a garment, or blend the two.
		const prompt = buildPlacementPrompt(placement());
		expect(prompt).toMatch(/FIRST image/);
		expect(prompt).toMatch(/SECOND image/);
		expect(prompt).toMatch(/do not redraw it/i);
	});

	it("never leaks an enum-only token into the prompt", () => {
		const prompt = buildPlacementPrompt(placement({
			garment_type: "tshirt",
			regions: ["back", "hem", "neck", "sleeve", "front"],
			coverage: "trim",
			pattern_scale: "large",
		})).toLowerCase();

		// Only the tokens that exist nowhere in English are checked. `hem`,
		// `sleeve`, `neck`, `panel` and `trim` are ordinary words that the region
		// and coverage descriptions rightly use — "a band along the bottom hem"
		// is what we want the model to read, not a leak. `tshirt` and `allover`
		// are enum spellings that could only ever arrive by a missing gloss.
		for (const leak of ["tshirt", "allover", "half-drop", "undefined"]) {
			expect(prompt).not.toContain(leak);
		}
	});

	it("translates coverage and scale into phrases rather than the enum word", () => {
		const trim = buildPlacementPrompt(placement({ coverage: "trim" }));
		expect(trim).toContain("narrow decorative border");

		const large = buildPlacementPrompt(placement({ pattern_scale: "large" }));
		expect(large).toContain("large and bold");
	});

	it("distinguishes every coverage value", () => {
		const prompts = (["allover", "panel", "trim"] as const).map((coverage) =>
			buildPlacementPrompt(placement({ coverage })),
		);
		expect(new Set(prompts).size).toBe(3);
	});

	it("distinguishes every pattern scale", () => {
		const prompts = (["small", "medium", "large"] as const).map((pattern_scale) =>
			buildPlacementPrompt(placement({ pattern_scale })),
		);
		expect(new Set(prompts).size).toBe(3);
	});
});

describe("validRegionsFor", () => {
	it("rejects a sleeve on a scarf", () => {
		const { valid, rejected } = validRegionsFor("scarf", ["front", "sleeve"]);
		expect(valid).toEqual(["front"]);
		expect(rejected).toEqual(["sleeve"]);
	});

	it("rejects a neck on a scarf", () => {
		expect(validRegionsFor("scarf", ["neck"]).rejected).toEqual(["neck"]);
	});

	it("rejects a sleeve on a sleeveless dress", () => {
		expect(validRegionsFor("dress", ["sleeve"]).rejected).toEqual(["sleeve"]);
	});

	it("keeps all five on a hoodie", () => {
		const all = [...GarmentRegionSchema.options];
		const { valid, rejected } = validRegionsFor("hoodie", all);
		expect(valid).toEqual(all);
		expect(rejected).toEqual([]);
	});
});

describe("PLACEMENT_PROMPT_VERSION", () => {
	it("is exported and non-empty, so it can reach the row", () => {
		// It is the only surviving answer to "what was the prompt" when output
		// quality changes, and it only helps if it lands on garment_regions.
		expect(PLACEMENT_PROMPT_VERSION).toBe("atlas-placement-v1");
	});
});
