import type { IrisParams } from "@aureline/shared-types";
import { COLOR_GLOSSARY } from "./color.glossary";

/* Versioned identity. Never edit a prompt in place, bump the ID. */
export const IRIS_COLOR_PROMPT_VERSION = "iris-color-v1";

/**
 * Deterministic translator from IrisParams -> one English sentence for the image model.
 * No design judgement. Same params always produce the same string.
 *
 * Clause order matters: palette leads, mood trails.
 */
export function buildColorPrompt(params: IrisParams): string {
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

  // Palette first, mood last — models weight early clauses more heavily.
  const clauses = [
    paletteClause,
    harmonyClause,
    saturationClause,
    backgroundClause,
    moodClause,
  ];

  return `${clauses.join(". ")}.`;
}
