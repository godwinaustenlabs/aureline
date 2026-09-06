import { describe, it, expect } from "vitest";
import type { Classification } from "@aureline/shared-types";
import {
	PLANNER_PROMPT_ID,
	appendPlannerConstraints,
	buildPlannerConstraints,
	buildPlannerSystemPrompt,
	buildPlannerUserPrompt,
} from "./planner.prompt";

const TILE: Classification = { mode: "tile" };
const MOTIF: Classification = { mode: "motif", garment_part: "neckline" };
const SOURCES = '<source name="tiling.md">Edges must meet.</source>';

describe("buildPlannerSystemPrompt with no constraints", () => {
	it("is byte-identical whether the argument is absent, empty or blank", () => {
		// The v3 regression promise. Everything v3 added lives inside the
		// constraints branch, so a run with no retrieval sends exactly the prompt
		// v2 sent — and a run that retrieved nothing must not be handed
		// instructions for reading source blocks it was never given.
		const base = buildPlannerSystemPrompt();

		expect(buildPlannerSystemPrompt("")).toBe(base);
		expect(buildPlannerSystemPrompt(undefined)).toBe(base);
	});

	it("mentions nothing about sources, design modes or garment parts", () => {
		const prompt = buildPlannerSystemPrompt();

		expect(prompt).not.toContain("<source");
		expect(prompt).not.toContain("Design mode");
		expect(prompt).not.toContain("Garment part");
		expect(prompt).not.toContain("Brand and design constraints");
	});

	it("still returns the whole prompt", () => {
		const prompt = buildPlannerSystemPrompt();

		expect(prompt).toContain("You are a textile pattern designer.");
		expect(prompt).toContain("# Output format");
		expect(prompt).toContain("# Examples");
	});
});

describe("buildPlannerSystemPrompt with constraints", () => {
	it("injects them after the vocabulary and before the examples", () => {
		// Injected constraints override the general guidance, while the examples
		// keep the last word on output shape.
		const prompt = buildPlannerSystemPrompt(SOURCES);

		expect(prompt.indexOf("# Designer vocabulary")).toBeLessThan(
			prompt.indexOf("# Brand and design constraints"),
		);
		expect(prompt.indexOf("# Brand and design constraints")).toBeLessThan(prompt.indexOf("# Examples"));
	});

	it("explains how to read a source block, not just that one is there", () => {
		// More context in front of a model is worth nothing if the model has not
		// been told what to do with it: a planner handed sources and no
		// instruction starts designing the documents rather than from them.
		const prompt = buildPlannerSystemPrompt(SOURCES);

		expect(prompt).toContain("reference documents retrieved for this brief");
		expect(prompt).toContain("not as part of the brief");
		expect(prompt).toContain(SOURCES);
	});

	it("explains both design modes and the garment part", () => {
		const prompt = buildPlannerSystemPrompt(SOURCES);

		expect(prompt).toContain("Design mode: tile");
		expect(prompt).toContain("Design mode: motif");
		expect(prompt).toContain("Garment part:");
	});

	it("tells the planner it may ignore thin or irrelevant sources", () => {
		// Retrieval that found little is an ordinary outcome, and a planner that
		// forces weak sources in produces a worse design than one that ignores them.
		expect(buildPlannerSystemPrompt(SOURCES)).toContain("fall back on the general guidance above");
	});
});

describe("buildPlannerConstraints", () => {
	it("states the mode first, so sources are read in light of it", () => {
		expect(buildPlannerConstraints(TILE, SOURCES)).toBe(`Design mode: tile\n\n${SOURCES}`);
	});

	it("includes the garment part when a motif has one", () => {
		expect(buildPlannerConstraints(MOTIF, null)).toBe("Design mode: motif\n\nGarment part: neckline");
	});

	it("omits the garment part when there is none", () => {
		expect(buildPlannerConstraints({ mode: "motif" }, null)).toBe("Design mode: motif");
	});

	it("still passes the mode when retrieval found nothing", () => {
		// `context: null` is "retrieval was off, or found nothing" — both ordinary.
		// The classification is not retrieval and must survive either.
		expect(buildPlannerConstraints(TILE, null)).toBe("Design mode: tile");
		expect(buildPlannerConstraints(TILE, "   ")).toBe("Design mode: tile");
	});

	it("returns undefined when there is nothing to say at all", () => {
		// Rather than an empty constraints heading with nothing under it.
		expect(buildPlannerConstraints(undefined, null)).toBeUndefined();
	});
});

describe("appendPlannerConstraints", () => {
	it("returns the prompt untouched when there is nothing to add", () => {
		expect(appendPlannerConstraints("STORED PROMPT", undefined)).toBe("STORED PROMPT");
		expect(appendPlannerConstraints("STORED PROMPT", "  ")).toBe("STORED PROMPT");
	});

	it("appends the same section the code fallback builds", () => {
		// Two copies of this block would drift, and the drift would be invisible:
		// a run on the stored prompt would get different framing from one on the
		// fallback, with nothing to say why.
		const appended = appendPlannerConstraints("STORED PROMPT", SOURCES);
		const builtIn = buildPlannerSystemPrompt(SOURCES);
		const section = (text: string) => text.slice(text.indexOf("# Brand and design constraints"));

		expect(appended).toContain("STORED PROMPT");
		expect(section(builtIn)).toContain(section(appended).trimEnd());
	});
});

describe("buildPlannerUserPrompt", () => {
	it("is the brief and nothing else", () => {
		expect(buildPlannerUserPrompt("an art deco paisley")).toBe("Brief: an art deco paisley");
	});
});

describe("PLANNER_PROMPT_ID", () => {
	it("is v3", () => {
		// Never edit a prompt in place — bump the id. `prompt_version` on the audit
		// row is what makes a run reproducible.
		expect(PLANNER_PROMPT_ID).toBe("helios-planner-v3");
	});
});
