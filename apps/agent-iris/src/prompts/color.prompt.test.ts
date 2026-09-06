import { describe, it, expect } from "vitest";
import type { IrisParams } from "@aureline/shared-types";
import { IrisParamsSchema } from "@aureline/shared-types";
import {
  buildColorPrompt,
  buildImageModelPrompt,
  IRIS_COLOR_PROMPT_VERSION,
} from "./color.prompt";
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
      image_prompt: "Let the sand carry the texture and keep the ivory clean.",
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
      image_prompt: "Confine the gold to the finest details.",
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
      image_prompt: "Hold the charcoal flat and even, with no gradient.",
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
    expect(IRIS_COLOR_PROMPT_VERSION).toBe("iris-color-v4");
  });
});

describe("buildImageModelPrompt", () => {
  const { params } = CASES[1];

  it("is the deterministic prompt followed by image_prompt, in that order", () => {
    // The exact composed string, not a `toContain` on each half. Order is the
    // whole contract here — the deterministic layer has to come first, because
    // the model weights earlier clauses more heavily and the free-form layer is
    // only ever allowed to add.
    expect(buildImageModelPrompt(params)).toBe(
      `${buildColorPrompt(params)} Confine the gold to the finest details.`,
    );
  });

  it("puts image_prompt after every deterministic clause", () => {
    const composed = buildImageModelPrompt(params);

    // Positional rather than presence-based: both halves being in the string
    // would pass even if they were emitted the wrong way round.
    expect(composed.indexOf("Confine the gold")).toBeGreaterThan(
      composed.indexOf(params.mood),
    );
  });

  it("does not alter buildColorPrompt's own output", () => {
    // The two layers stay separable. A reader looking at a run has to be able
    // to tell which words we wrote and which the planner did.
    expect(buildImageModelPrompt(params).startsWith(buildColorPrompt(params))).toBe(true);
  });

  it("trims surrounding whitespace from image_prompt", () => {
    const padded: IrisParams = { ...params, image_prompt: "  Keep it flat.  " };

    expect(buildImageModelPrompt(padded)).toBe(`${buildColorPrompt(padded)} Keep it flat.`);
  });

  it("varies with image_prompt alone", () => {
    // Without this, everything above would still pass if the function ignored
    // `image_prompt` and returned `buildColorPrompt` unchanged.
    const other: IrisParams = { ...params, image_prompt: "Something else entirely." };

    expect(buildImageModelPrompt(other)).not.toBe(buildImageModelPrompt(params));
  });
});

describe("buildImageModelPrompt and the reference image clause", () => {
  const { params } = CASES[1];

  it("adds nothing at all without a reference image", () => {
    // The regression promise as an equality rather than a `not.toContain`: a run
    // with no upload must produce the exact string it produced before this
    // existed, not merely one that lacks the new clause.
    expect(buildImageModelPrompt(params, { hasReferenceImage: false })).toBe(
      buildImageModelPrompt(params),
    );
  });

  it("leads with the clause naming which image is which", () => {
    // First, not appended. The model has to know which picture the palette
    // instruction applies to before it reads the palette instruction.
    const prompt = buildImageModelPrompt(params, { hasReferenceImage: true });

    expect(prompt.startsWith("You are given two images.")).toBe(true);
    expect(prompt).toContain("The first is the pattern to colour");
    expect(prompt).toContain("The second is a colour reference");
  });

  it("tells the model to take colour from the reference but not its shapes", () => {
    // Shape, motif, line weight and repeat belong to Helios. A reference that
    // alters the drawing has broken the engine boundary, not just this run.
    expect(buildImageModelPrompt(params, { hasReferenceImage: true })).toContain(
      "never its shapes or motifs",
    );
  });

  it("keeps the deterministic half and image_prompt intact, in the same order", () => {
    // The clause is added in front of the existing string, not woven into it —
    // so a reader can still tell which words came from us, which from the
    // planner, and which from this.
    const withReference = buildImageModelPrompt(params, { hasReferenceImage: true });

    expect(withReference.endsWith(buildImageModelPrompt(params))).toBe(true);
  });
});

describe("mode clauses", () => {
  const { params } = CASES[0];

  it("omits mode clause when no classification is provided", () => {
    const prompt = buildColorPrompt(params);
    expect(prompt).not.toContain("seamless repeating tile pattern");
    expect(prompt).not.toContain("single motif");
  });

  it("prepends tile clause when classification.mode is tile", () => {
    const classification = { mode: "tile" as const, confidence: 0.95, signals: ["geometric"] };
    const prompt = buildColorPrompt(params, { classification });
    expect(prompt.startsWith("Colour palette for a seamless repeating tile pattern")).toBe(true);
  });

  it("prepends motif clause when classification.mode is motif", () => {
    const classification = { mode: "motif" as const, confidence: 0.88, garment_part: "scarf" };
    const prompt = buildColorPrompt(params, { classification });
    expect(prompt).toContain("Colour palette for a single motif on a scarf");
  });

  it("prepends motif clause without garment_part when not specified", () => {
    const classification = { mode: "motif" as const, confidence: 0.7, garment_part: undefined };
    const prompt = buildColorPrompt(params, { classification });
    expect(prompt).toContain("Colour palette for a single motif");
    expect(prompt).not.toContain("on a");
  });

  it("mode clause comes before palette clause", () => {
    const classification = { mode: "tile" as const, confidence: 0.9, signals: [] };
    const prompt = buildColorPrompt(params, { classification });
    const modeIdx = prompt.indexOf("seamless repeating tile pattern");
    const paletteIdx = prompt.indexOf("Colour palette:");
    expect(modeIdx).toBeLessThan(paletteIdx);
  });

  it("buildImageModelPrompt also includes mode clause when classification is provided", () => {
    const classification = { mode: "motif" as const, confidence: 0.85, garment_part: "dress" };
    const prompt = buildImageModelPrompt(params, { classification });
    expect(prompt).toContain("single motif on a dress");
  });
});
