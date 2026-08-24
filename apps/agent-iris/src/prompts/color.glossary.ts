import type { ColorName, IrisParams } from "@aureline/shared-types";

/**
 * One entry per ColorName.
 * Typed as a full Record so adding a name to ColorNameSchema without adding it here is a compile error.
 */
export const COLOR_GLOSSARY: Record<ColorName, { hex: string; gloss: string }> = {
  // Neutrals
  ivory:        { hex: "#F5F1E6", gloss: "a warm off-white, barely tinted, reads as unbleached cloth" },
  cream:        { hex: "#F8F0E0", gloss: "soft creamy white with a slight yellow cast, like aged linen" },
  sand:         { hex: "#D4C4A8", gloss: "light warm beige, the colour of dry beach sand" },
  taupe:        { hex: "#B8A99A", gloss: "muted grey-brown, neither warm nor cool, very versatile" },
  stone:        { hex: "#9A958C", gloss: "cool medium grey with a mineral feel" },
  charcoal:     { hex: "#36454F", gloss: "deep soft black with a blue-grey undertone" },
  black:        { hex: "#1A1A1A", gloss: "true near-black, dense and absolute" },
  white:        { hex: "#FAFAFA", gloss: "clean bright white, slightly cooler than ivory" },

  // Reds / Pinks
  crimson:      { hex: "#9B1B30", gloss: "deep strong red with a slight blue undertone" },
  rust:         { hex: "#B7410E", gloss: "earthy orange-red, the colour of oxidised iron" },
  terracotta:   { hex: "#C46A3F", gloss: "warm baked-clay orange-red, classic for earthy palettes" },
  coral:        { hex: "#E07A5F", gloss: "soft living orange-pink, warmer and lighter than terracotta" },
  blush:        { hex: "#E8B4B8", gloss: "very light dusty pink, almost neutral" },
  rose:         { hex: "#C98B9A", gloss: "muted mid pink with a grey cast" },

  // Yellows / Golds
  amber:        { hex: "#D4A017", gloss: "rich warm golden yellow, like resin" },
  gold:         { hex: "#C9A227", gloss: "metallic warm yellow, reads as luxury metal" },
  mustard:      { hex: "#C4A35A", gloss: "earthy yellow-brown, classic for vintage and workwear" },
  ochre:        { hex: "#CC7722", gloss: "deep earthy yellow-orange, pigment-like" },

  // Greens
  olive:        { hex: "#6B6B3D", gloss: "muted yellow-green, the colour of olive foliage" },
  sage:         { hex: "#9CAF88", gloss: "soft grey-green, calm and dusty" },
  emerald:      { hex: "#046307", gloss: "deep pure green with a jewel quality" },
  forest_green: { hex: "#1B4D3E", gloss: "dark cool green, the colour of deep woodland" },
  mint:         { hex: "#A8E6CF", gloss: "light fresh green with a cool, almost blue cast" },

  // Blues / Teals
  teal:         { hex: "#008080", gloss: "balanced blue-green, neither too blue nor too green" },
  turquoise:    { hex: "#40E0D0", gloss: "bright clear blue-green, lively and clean" },
  cobalt:       { hex: "#0047AB", gloss: "strong pure blue with a slight violet lean" },
  navy:         { hex: "#000080", gloss: "very dark blue, almost black in low light" },
  indigo:       { hex: "#3F00FF", gloss: "deep blue with a clear violet undertone" },

  // Purples / Deep reds
  plum:         { hex: "#8E4585", gloss: "muted purple with a red base, soft and rich" },
  burgundy:     { hex: "#800020", gloss: "deep wine red, darker and cooler than crimson" },
};

export const HARMONY_GLOSSARY: Record<IrisParams["harmony"], string> = {
  monochrome:     "variations of a single hue only",
  analogous:      "colours that sit next to each other on the colour wheel",
  complementary:  "colours opposite each other on the colour wheel",
  triadic:        "three colours evenly spaced around the colour wheel",
  neutral:        "mostly neutrals with very limited accent colour",
};

export const SATURATION_GLOSSARY: Record<IrisParams["saturation"], string> = {
  muted:     "softened, greyed-down, low intensity",
  balanced:  "neither washed out nor oversaturated",
  vibrant:   "full intensity, clear and lively",
};

export const BACKGROUND_GLOSSARY: Record<IrisParams["background_treatment"], string> = {
  solid:        "flat single colour filling the entire ground",
  gradient:     "smooth transition between two related colours",
  textured:     "subtle fabric-like or paper-like surface variation",
  transparent:  "no filled background — the motif sits on clear ground",
};
