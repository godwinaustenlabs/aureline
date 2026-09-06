import type { Classification, IrisParams } from "@aureline/shared-types";
import { COLOR_GLOSSARY } from "./color.glossary";

/* Versioned identity. Never edit a prompt in place, bump the ID.
 *
 * v2 adds the `image_prompt` layer. `buildColorPrompt` itself is unchanged —
 * the version covers the whole composed string, which `buildImageModelPrompt`
 * now produces.
 *
 * v3 leads with a clause naming which of the two input images is which, on the
 * runs that carry a reference image.
 *
 * v4 adds mode-selected clauses: tile gets seamless-repeat language, motif gets
 * garment-part language. */
export const IRIS_COLOR_PROMPT_VERSION = "iris-color-v4";

/**
 * Deterministic translator from IrisParams -> one English sentence for the image model.
 * No design judgement. Same params always produce the same string.
 *
 * Clause order matters: palette leads, mood trails.
 */
export function buildColorPrompt(
  params: IrisParams,
  options: { classification?: Classification } = {},
): string {
  const primary = COLOR_GLOSSARY[params.primary_color];
  const secondary = params.secondary_color
    ? COLOR_GLOSSARY[params.secondary_color]
    : null;
  const accent = params.accent_color
    ? COLOR_GLOSSARY[params.accent_color]
    : null;

  const paletteParts: string[] = [
    `primary colour ${params.primary_color} (${primary.hex})`,
  ];

  if (secondary) {
    paletteParts.push(`secondary colour ${params.secondary_color} (${secondary.hex})`);
  }
  if (accent) {
    paletteParts.push(`accent colour ${params.accent_color} (${accent.hex})`);
  }

  const paletteClause = `Colour palette: ${paletteParts.join(", ")}`;

  const harmonyClause = `${params.harmony} harmony`;
  const saturationClause = `${params.saturation} saturation`;
  const backgroundClause = `background ${params.background_treatment}`;
  const moodClause = `mood: ${params.mood.trim().toLowerCase()}`;

  // Mode clause first, then palette, mood last — models weight early clauses
  // more heavily. Mode is the highest-level instruction and must not be diluted
  // by the palette details that follow.
  const modeClause = modeClauseFor(options.classification);

  const clauses = [
    ...(modeClause !== null ? [modeClause] : []),
    paletteClause,
    harmonyClause,
    saturationClause,
    backgroundClause,
    moodClause,
  ];

  return `${clauses.join(". ")}.`;
}

/**
 * The string actually sent to the image model: the deterministic template,
 * then the planner's own instruction.
 *
 * These are the two layers of the prompt strategy in
 * `docs/Project Wide/phase-1-plan.md` §6, and the order is the whole point.
 * `buildColorPrompt` runs first and is unchanged, because it is the part we
 * control and the part that keeps two runs of the same params comparable.
 * `image_prompt` is appended after it, never merged into it, so a reader can
 * always tell which words came from the planner and which from us.
 *
 * Last, rather than first, because earlier clauses carry more weight with the
 * model. The free-form layer adds; it does not get to override the palette.
 *
 * `buildColorPrompt` stays exported and stays independently tested. It is still
 * the deterministic half on its own, and a test that asserts on the composed
 * string cannot tell you which half moved when it changes.
 *
 * When a reference image is attached the model receives **two** images, and a
 * clause naming which is which leads the whole string — see
 * `REFERENCE_IMAGE_CLAUSE`.
 */
export function buildImageModelPrompt(
  params: IrisParams,
  options: { hasReferenceImage?: boolean; classification?: Classification } = {},
): string {
  const lead = options.hasReferenceImage ? `${REFERENCE_IMAGE_CLAUSE} ` : "";

  return `${lead}${buildColorPrompt(params, { classification: options.classification })} ${params.image_prompt.trim()}`;
}

/**
 * Which of the two images is which.
 *
 * **First, not last**, and that is the one place this deviates from the
 * append-only rule above. Everything else in this file describes the output;
 * this describes the *inputs*, and a model that has already read a palette
 * instruction before learning which picture it applies to has to reinterpret it.
 * Earlier clauses carry more weight, and nothing carries more weight than not
 * confusing the pattern with the photograph.
 *
 * The failure it prevents is a full-price one that looks like the model ignored
 * us: handed two images and no explanation, an image-to-image model blends them,
 * or recolours the photograph and reads the pattern as a palette. Both come back
 * as a plausible image that is not a coloured version of the Helios motif.
 *
 * "never its shapes or motifs" is doing real work. Shape, motif, line weight and
 * repeat belong to Helios — Iris decides colour and nothing else — so a
 * reference that alters the drawing has broken the engine boundary, not just
 * this run.
 */
/**
 * Mode-selected clause: tile gets seamless-repeat language, motif gets
 * garment-part language. When no classification is present, returns null — the
 * clause is omitted entirely rather than guessing.
 *
 * Tile and motif are mutually exclusive by definition (the classifier decides
 * one or the other), so this is a simple if/else, not a switch.
 */
function modeClauseFor(classification: Classification | undefined): string | null {
  if (classification === undefined) return null;

  if (classification.mode === "tile") {
    return "Colour palette for a seamless repeating tile pattern";
  }

  const part =
    classification.garment_part !== undefined ? ` on a ${classification.garment_part}` : "";
  return `Colour palette for a single motif${part}`;
}

const REFERENCE_IMAGE_CLAUSE =
  "You are given two images. The first is the pattern to colour; reproduce its " +
  "shapes and linework exactly. The second is a colour reference: take its palette " +
  "and mood from it, never its shapes or motifs.";
