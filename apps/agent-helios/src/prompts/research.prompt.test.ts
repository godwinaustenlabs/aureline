import { describe, it, expect } from "vitest";
import type { Classification } from "@aureline/shared-types";
import { SEARCH_TOOL } from "@aureline/shared-utils";
import { HELIOS_RESEARCH_PROMPT_VERSION, buildResearchSystemPrompt } from "./research.prompt";

const TILE: Classification = { mode: "tile" };
const MOTIF: Classification = { mode: "motif" };
const MOTIF_WITH_PART: Classification = { mode: "motif", garment_part: "neckline" };

describe("buildResearchSystemPrompt", () => {
	it("returns the same string every time for the same argument", () => {
		// The code fallback for a database-backed prompt, so two runs on one brief
		// have to be comparable. A builder that varied per call would make them
		// differ for a reason no audit row records.
		expect(buildResearchSystemPrompt()).toBe(buildResearchSystemPrompt());
		expect(buildResearchSystemPrompt(TILE)).toBe(buildResearchSystemPrompt(TILE));
	});

	it("names the search tool exactly as shared-utils defines it", () => {
		// The prompt spells the name as prose and SEARCH_TOOL declares it as data.
		// Renaming one without the other tells the model to call something that
		// does not exist, and the model would simply not search — a run that
		// completes looking entirely normal with no retrieval in it.
		expect(buildResearchSystemPrompt()).toContain(SEARCH_TOOL.name);
	});

	it("says what the tool searches and when to reach for it", () => {
		const prompt = buildResearchSystemPrompt();

		expect(prompt).toContain("reference knowledge base of textile design guidance");
		expect(prompt).toContain("before deciding a design direction");
	});
});

describe("buildResearchSystemPrompt and the classification", () => {
	it("tells a tile run to search for repeats rather than placement", () => {
		const prompt = buildResearchSystemPrompt(TILE);

		expect(prompt).toContain("TILE");
		expect(prompt).toContain("edges must meet without a visible seam");
		expect(prompt).toContain("not about placement on a garment");
	});

	it("tells a motif run to search for placement rather than tiling", () => {
		const prompt = buildResearchSystemPrompt(MOTIF);

		expect(prompt).toContain("MOTIF");
		expect(prompt).toContain("placed once, not a repeat");
		expect(prompt).toContain("not about tiling or seamless repeats");
	});

	it("keeps the two modes' guidance mutually exclusive", () => {
		// Both clauses in one prompt would be a contradiction the model resolves
		// however it likes, and the run would look normal either way.
		const tile = buildResearchSystemPrompt(TILE);
		const motif = buildResearchSystemPrompt(MOTIF);

		expect(tile).not.toContain("MOTIF");
		expect(motif).not.toContain("TILE");
	});

	it("names the garment part when there is one", () => {
		expect(buildResearchSystemPrompt(MOTIF_WITH_PART)).toContain(
			"The garment part is: neckline",
		);
	});

	it("says nothing about a garment part when the motif has none", () => {
		// "A single peacock motif" names no place, and a prompt that asked the
		// model to search for one would send it looking for guidance about a part
		// nobody chose.
		expect(buildResearchSystemPrompt(MOTIF)).not.toContain("garment part is");
	});

	it("never claims a garment part for a tile", () => {
		expect(buildResearchSystemPrompt(TILE)).not.toContain("garment part is");
	});

	it("says nothing has been decided when it is given no classification", () => {
		// The parameter is optional so the code fallback can be built without one.
		// An absent classification must not put the word "undefined" in front of a
		// model, and must not silently assert a mode nobody chose.
		const prompt = buildResearchSystemPrompt();

		expect(prompt).not.toContain("undefined");
		expect(prompt).not.toContain("What has already been decided");
		expect(prompt).not.toContain("TILE");
		expect(prompt).not.toContain("MOTIF");
	});
});

describe("buildResearchSystemPrompt and the budget", () => {
	it("says searching more than once is allowed, and that there is a limit", () => {
		const prompt = buildResearchSystemPrompt();

		expect(prompt).toContain("search more than once");
		expect(prompt).toContain("limit on how many times");
	});

	it("says not searching at all is a valid answer", () => {
		// Recorded as quality "none", not as a failure. A model that believes it
		// must always search burns a billed call and grounds the planner on
		// irrelevant text.
		expect(buildResearchSystemPrompt()).toContain("Not searching is a valid answer");
	});

	it("tells the model a thin result usually means bad wording, and to stop after two", () => {
		const prompt = buildResearchSystemPrompt();

		expect(prompt).toContain("try different vocabulary for the same idea");
		expect(prompt).toContain("stop rather than trying a third variation");
	});

	it("says an ungrounded design is acceptable rather than a failure", () => {
		// An empty knowledge base is a working state — the thing that makes it
		// possible to ship this phase before the content exists.
		expect(buildResearchSystemPrompt()).toContain("acceptable outcome and not a failure");
	});
});

describe("HELIOS_RESEARCH_PROMPT_VERSION", () => {
	it("is v1", () => {
		// Never edit a prompt in place — bump the id.
		expect(HELIOS_RESEARCH_PROMPT_VERSION).toBe("helios-research-v1");
	});
});
