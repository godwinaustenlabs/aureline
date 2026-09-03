import { describe, it, expect } from "vitest";
import { HELIOS_CLASSIFIER_PROMPT_VERSION, buildClassifierSystemPrompt } from "./classifier.prompt";

describe("buildClassifierSystemPrompt", () => {
	it("returns the same string every time it is called", () => {
		// This is the code fallback for a database-backed prompt, so two runs on
		// one brief have to be comparable. A builder that varied per call would
		// make them differ for a reason no audit row records.
		expect(buildClassifierSystemPrompt()).toBe(buildClassifierSystemPrompt());
	});

	it("defines both modes by name", () => {
		const prompt = buildClassifierSystemPrompt();

		expect(prompt).toContain("tile");
		expect(prompt).toContain("motif");
	});

	it("defines a tile by whether it repeats, not by what it depicts", () => {
		// The distinction the model has to get right. "Seamless" and "repeating"
		// are the words carrying it.
		const prompt = buildClassifierSystemPrompt();

		expect(prompt).toContain("seamless repeating unit");
		expect(prompt).toContain("edges must be continuous");
	});

	it("names every garment part it will accept", () => {
		// A closed list, because `garment_part` reaches the image model as an
		// instruction and a part the model invents produces a design tailored to
		// somewhere nobody asked for. `ClassificationSchema` caps the length but
		// cannot constrain the vocabulary — this prompt is where that happens.
		const prompt = buildClassifierSystemPrompt();

		for (const part of ["neckline", "back", "front", "sleeve", "cuff", "hem", "yoke", "panel"]) {
			expect(prompt).toContain(part);
		}
	});

	it("tells the model to leave the part out rather than guess one", () => {
		const prompt = buildClassifierSystemPrompt();

		expect(prompt).toContain("Leave it out entirely");
		// Matched without the line wrap between "from the" and "subject matter" —
		// asserting across a wrap makes the test fail on reflowing rather than on
		// the guidance changing.
		expect(prompt).toContain("Do not infer one");
		expect(prompt).toContain("do not pick a likely one");
	});

	it("resolves the tile-versus-garment-word trap explicitly", () => {
		// "A seamless sleeve pattern" names a garment part and is still a tile.
		// Naming the trap in the prompt is cheaper than discovering it in a run.
		expect(buildClassifierSystemPrompt()).toContain("seamless sleeve pattern");
	});

	it("gives an answer for an ambiguous brief instead of leaving it open", () => {
		const prompt = buildClassifierSystemPrompt();

		expect(prompt).toContain("ambiguous");
		expect(prompt).toContain("a floral design");
	});

	it("says what the reference image is for, and that the words win", () => {
		const prompt = buildClassifierSystemPrompt();

		expect(prompt).toContain("reference image");
		expect(prompt).toContain("follow the words");
	});

	it("asks for JSON alone", () => {
		const prompt = buildClassifierSystemPrompt();

		expect(prompt).toContain("JSON only");
		expect(prompt).toContain('{"mode": "tile"}');
	});

	it("is short, because this is a classification and not a design brief", () => {
		// Roughly 200-400 tokens (P2.md T2). Length here buys latency and a wider
		// surface for the model to be creative on, and creativity is the one thing
		// this call must not have.
		expect(buildClassifierSystemPrompt().length).toBeLessThan(2000);
	});

	it("is version v1", () => {
		// Never edit a prompt in place — bump the id. `prompt_version` on the audit
		// row is what makes a run reproducible, and an edited v1 silently redefines
		// every row already claiming to be v1.
		expect(HELIOS_CLASSIFIER_PROMPT_VERSION).toBe("helios-classifier-v1");
	});
});
