# Helios generates black-and-white patterns only — color is entirely Iris's responsibility

Helios is the Pattern Engine; Iris is the dedicated Chromatic Engine ("color palettes, colorways"). We initially considered giving Helios a minimal interim color hint (since Iris doesn't exist yet), but rejected it — it re-creates the exact overlap the two-engine split exists to avoid, and would need to be ripped out once Iris ships.

Instead, Helios's image output is grayscale/monochrome (line art / value pattern, no hue) from the start. `HeliosParams` carries no color field. The image generation prompt explicitly instructs black-and-white/monochrome output. Colorizing a Helios pattern is future work owned entirely by Iris, once it exists.

Consequence: Helios's `HeliosParams` schema needs no color-related field at all — not even a placeholder — which also simplifies Sprint 1's planner schema.
