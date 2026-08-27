import { describe, it, expect } from "vitest";
import type { IrisParams } from "@aureline/shared-types";
import { IrisParamsSchema } from "@aureline/shared-types";
import { buildColorPrompt, IRIS_COLOR_PROMPT_VERSION } from "./color.prompt";
import { COLOR_GLOSSARY } from "./color.glossary";

/**
 * Complete, valid `IrisParams`. Built whole rather than as a partial plus a
 * cast, and run through the schema below so a drift in either direction fails
 * here rather than at the model call.
 */
const CASES: ReadonlyArray<{ name: string; params: IrisParams }> = [
  {
    name: "three colours",
    params: {
      primary_color: "terracotta",
      secondary_color: "sand",
      accent_color: "ivory",
      harmony: "analogous",
      saturation: "muted",
      background_treatment: "textured",
      mood: "earthy warm",
    },
  },
  {
    name: "two colours",
    params: {
      primary_color: "navy",
      secondary_color: "gold",
      harmony: "complementary",
      saturation: "balanced",
      background_treatment: "solid",
      mood: "opulent traditional",
    },
  },
  {
    name: "primary only",
    params: {
      primary_color: "charcoal",
      harmony: "monochrome",
      saturation: "vibrant",
      background_treatment: "transparent",
      mood: "stark modern",
    },
  },
];

describe("buildColorPrompt", () => {
  it("uses fixtures that are valid IrisParams", () => {
    // If this fails, every assertion below is testing against a shape the
    // planner could never actually produce.
    for (const { params } of CASES) {
      expect(IrisParamsSchema.safeParse(params).success).toBe(true);
    }
  });

  for (const { name, params } of CASES) {
    it(`is deterministic for ${name}`, () => {
      // The reason this matters: the prompt is recorded on the audit row and a
      // run is meant to be replayable from it. A prompt that varied between
      // calls would make two runs of the same params incomparable.
      expect(buildColorPrompt(params)).toBe(buildColorPrompt(params));
    });

    it(`names both the colour and its hex for ${name}`, () => {
      const prompt = buildColorPrompt(params);

      const colors = [
        params.primary_color,
        params.secondary_color,
        params.accent_color,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);

      for (const color of colors) {
        expect(prompt).toContain(color);
        expect(prompt).toContain(COLOR_GLOSSARY[color].hex);
      }
    });

    it(`puts the palette first and the mood last for ${name}`, () => {
      const prompt = buildColorPrompt(params);

      // These models weight early clauses more heavily, which is why the
      // ordering is a decision rather than an accident.
      expect(prompt.indexOf("Colour palette:")).toBe(0);
      expect(prompt.trimEnd().endsWith(`mood: ${params.mood}.`)).toBe(true);
    });
  }

  it("omits absent optional colours rather than leaving a dangling clause", () => {
    const prompt = buildColorPrompt(CASES[2]!.params);

    expect(prompt).toContain("charcoal");
    expect(prompt).not.toContain("secondary colour");
    expect(prompt).not.toContain("accent colour");
    expect(prompt).not.toContain("undefined");
    // The specific failure this guards: a join that leaves ", ." or " and ."
    // behind when the optional fields are absent.
    expect(prompt).not.toMatch(/,\s*\.|\band\s*\./);
  });

  it("produces a different prompt for different params", () => {
    // Without this, every assertion above would still pass if buildColorPrompt
    // returned a constant.
    const prompts = CASES.map(({ params }) => buildColorPrompt(params));

    expect(new Set(prompts).size).toBe(CASES.length);
  });

  it("exports a version id", () => {
    // Prompts are never edited in place; the id is how a stored run says which
    // wording produced it.
    expect(IRIS_COLOR_PROMPT_VERSION).toBe("iris-color-v1");
  });
});
