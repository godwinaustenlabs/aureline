import { describe, it, expect } from "vitest";
import type { Classification } from "@aureline/shared-types";
import {
  buildResearchSystemPrompt,
  buildResearchUserPrompt,
  IRIS_RESEARCH_PROMPT_VERSION,
} from "./research.prompt";

describe("buildResearchSystemPrompt", () => {
  it("contains the search tool name", () => {
    const prompt = buildResearchSystemPrompt();
    expect(prompt).toContain("search_design_reference");
  });

  it("contains tool usage instructions", () => {
    const prompt = buildResearchSystemPrompt();
    expect(prompt).toContain("Use it before deciding");
  });

  it("warns against inventing direction without search", () => {
    const prompt = buildResearchSystemPrompt();
    expect(prompt).toContain("informed rather than invented");
  });

  it("always returns the same prompt", () => {
    const a = buildResearchSystemPrompt();
    const b = buildResearchSystemPrompt();
    expect(a).toBe(b);
  });

  it("exported version is iris-research-v1", () => {
    expect(IRIS_RESEARCH_PROMPT_VERSION).toBe("iris-research-v1");
  });

  it("includes tile-specific guidance when classification is tile", () => {
    const classification: Classification = { mode: "tile" };
    const prompt = buildResearchSystemPrompt(classification);
    expect(prompt).toContain("TILE");
    expect(prompt).toContain("seamless repeating unit");
  });

  it("includes motif-specific guidance when classification is motif", () => {
    const classification: Classification = { mode: "motif", garment_part: "scarf" };
    const prompt = buildResearchSystemPrompt(classification);
    expect(prompt).toContain("MOTIF");
    expect(prompt).toContain("single element placed once");
    expect(prompt).toContain("scarf");
  });
});

describe("buildResearchUserPrompt", () => {
  it("wraps a concept with tile classification", () => {
    const classification: Classification = { mode: "tile" };
    const result = buildResearchUserPrompt("geometric tile pattern", classification);
    expect(result).toContain("geometric tile pattern");
    expect(result).toContain("tile");
  });

  it("wraps a concept with motif classification", () => {
    const classification: Classification = { mode: "motif", garment_part: "scarf" };
    const result = buildResearchUserPrompt("ornate paisley design", classification);
    expect(result).toContain("ornate paisley design");
    expect(result).toContain("motif");
    expect(result).toContain("scarf");
  });

  it("wraps a concept with motif classification without garment_part", () => {
    const classification: Classification = { mode: "motif" };
    const result = buildResearchUserPrompt("single peacock motif", classification);
    expect(result).toContain("single peacock motif");
    expect(result).toContain("motif");
    expect(result).not.toContain("Garment part:");
  });
});
