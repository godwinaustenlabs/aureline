import { describe, it, expect } from "vitest";
import {
  buildPlannerSystemPrompt,
  buildPlannerUserPrompt,
  appendPlannerConstraints,
  IRIS_PLANNER_PROMPT_VERSION,
} from "./planner.prompt";

describe("buildPlannerSystemPrompt", () => {
  it("is a non-empty string", () => {
    const prompt = buildPlannerSystemPrompt();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("contains colour instructions", () => {
    const prompt = buildPlannerSystemPrompt();
    expect(prompt).toContain("colour designer");
  });

  it("always returns the same prompt", () => {
    const a = buildPlannerSystemPrompt();
    const b = buildPlannerSystemPrompt();
    expect(a).toBe(b);
  });
});

describe("buildPlannerUserPrompt", () => {
  it("wraps a concept string", () => {
    expect(buildPlannerUserPrompt("deep navy paisley")).toBe("Brief: deep navy paisley");
  });
});

describe("appendPlannerConstraints", () => {
  it("returns the prompt unchanged when constraints is undefined", () => {
    const prompt = "STORED PROMPT";
    expect(appendPlannerConstraints(prompt, undefined)).toBe(prompt);
  });

  it("returns the prompt unchanged when constraints is whitespace only", () => {
    const prompt = "STORED PROMPT";
    expect(appendPlannerConstraints(prompt, "  ")).toBe(prompt);
  });

  it("appends constraints under a heading", () => {
    const prompt = "STORED PROMPT";
    const result = appendPlannerConstraints(prompt, "silk is a natural fibre");
    expect(result).toContain("STORED PROMPT");
    expect(result).toContain("# Retrieved context");
    expect(result).toContain("silk is a natural fibre");
  });

  it("trims whitespace from constraints", () => {
    const result = appendPlannerConstraints("PROMPT", "  silk is a natural fibre  ");
    expect(result).toContain("silk is a natural fibre");
    expect(result).not.toContain("  silk");
  });
});

describe("IRIS_PLANNER_PROMPT_VERSION", () => {
  it("is iris-planner-v3", () => {
    expect(IRIS_PLANNER_PROMPT_VERSION).toBe("iris-planner-v3");
  });
});
