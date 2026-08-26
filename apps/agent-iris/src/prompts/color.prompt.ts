import { COLOR_GLOSSARY } from "./color.glossary";

type ColorName = keyof typeof COLOR_GLOSSARY;

interface IrisParams {
  primary_color: ColorName;
  secondary_color?: ColorName;
  accent_color?: ColorName;
  harmony: string;
  saturation: string;
  background_treatment: string;
  mood: string;
}

/** Versioned identity. Never edit a prompt in place — bump the ID. */
export const IRIS_COLOR_PROMPT_VERSION = "iris-color-v2";

/**
 * Deterministic translator from IrisParams → one English sentence for the image model.
 * No design judgement. Same params always produce the same string.
 *
 * Designed for structure-preserving recoloring of an existing black-and-white pattern.
 * Clause order: geometry lock first, then palette mapping, then mood.
 */
export function buildColorPrompt(params: IrisParams): string {
  const primary = COLOR_GLOSSARY[params.primary_color];
  const secondary = params.secondary_color
    ? COLOR_GLOSSARY[params.secondary_color]
    : null;
  const accent = params.accent_color
    ? COLOR_GLOSSARY[params.accent_color]
    : null;

  // Strong geometry lock must come first
  const geometryLock =
    "Recolor the existing black-and-white textile pattern. Keep the exact motif shapes, linework, repeat layout and geometry completely unchanged. Do not add, remove or distort any lines or shapes.";

  // How to apply the colors
  let colorMapping: string;
  if (secondary && accent) {
    colorMapping = `Use ${params.primary_color} (${primary.hex}) as the main fill for the motifs, ${params.secondary_color} (${secondary.hex}) for secondary areas of the motifs, and ${params.accent_color} (${accent.hex}) for small highlights only.`;
  } else if (secondary) {
    colorMapping = `Use ${params.primary_color} (${primary.hex}) as the main fill for the motifs and ${params.secondary_color} (${secondary.hex}) for secondary areas or the ground.`;
  } else {
    colorMapping = `Use ${params.primary_color} (${primary.hex}) as the main color for the motifs against a clean complementary ground.`;
  }

  const harmonyClause = `Apply ${params.harmony} color harmony.`;
  const saturationClause = `Keep saturation ${params.saturation}.`;
  const backgroundClause = `Background treatment: ${params.background_treatment}.`;
  const moodClause = `Overall mood: ${params.mood.trim().toLowerCase()}.`;
  const finalLock =
    "Flat seamless textile pattern only. No 3D, no fabric folds, no mockup, no extra objects, no new shapes.";

  const clauses = [
    geometryLock,
    colorMapping,
    harmonyClause,
    saturationClause,
    backgroundClause,
    moodClause,
    finalLock,
  ];

  return clauses.join(" ");
}